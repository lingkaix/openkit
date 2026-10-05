import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildWorkerCanonicalTerminalEventRecord,
  WorkerCanonicalEventRecordReaderSchema,
  WorkerCanonicalEventRecordEmissionSchema as WorkerCanonicalEventRecordSchema,
  WorkerCanonicalTerminalEventDataReaderSchema,
  WorkerCanonicalTerminalEventDataEmissionSchema as WorkerCanonicalTerminalEventDataSchema,
  WorkerCapabilityCallSummaryReaderSchema,
  WorkerCapabilityCallSummarySchema,
  WorkerControlHeartbeatRequestReaderSchema,
  WorkerControlHeartbeatRequestSchema,
  WorkerControlHeartbeatStatusSchema,
  WorkerControlOperationSchema,
  WorkerControlRequestEnvelopeReaderSchema,
  WorkerControlRequestEnvelopeSchema,
  WorkerControlResponseEnvelopeReaderSchema,
  WorkerControlResponseEnvelopeSchema,
  WorkerControlSupplyRefreshAckBodyReaderSchema,
  WorkerControlSupplyRefreshAckBodySchema,
  WorkerErrorEnvelopeReaderSchema,
  WorkerErrorEnvelopeSchema,
  WorkerLineageSchema,
  WorkerObservationContentChunkDataReaderSchema,
  WorkerObservationContentChunkDataEmissionSchema as WorkerObservationContentChunkDataSchema,
  WorkerObservationDataReaderSchema,
  WorkerObservationDataEmissionSchema as WorkerObservationDataSchema,
  WorkerObservationFactEmissionSchema as WorkerObservationFactSchema,
  WorkerRuntimeNativeOriginIndexEntryReaderSchema,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  WorkerRuntimeProvenanceFeatureSchema,
  WorkerRuntimeRawStreamManifestReaderSchema,
  WorkerRuntimeRawStreamManifestSchema,
  WorkerTranscriptItemRecordEmissionSchema,
  WorkerTranscriptRecordSchema,
} from './index.js';

const lineage = {
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  turnId: 'turn_demo',
  agentSessionId: 'as_demo',
  packageSnapshotId: 'aep_demo',
  requestId: 'req_demo',
};

describe('worker observation events', () => {
  const observation = {
    observationId: 'obs_1',
    sourceRef: 'source_1',
    sourceSequence: 0,
    observedAt: '2026-09-22T00:00:00.000Z',
    fact: {
      kind: 'assistant',
      runtimeOriginRef: 'origin_1',
      phase: 'updated',
      messageRef: 'message_1',
      representation: 'delta',
    },
    content: {
      state: 'expected',
      mediaType: 'text/plain',
      boundary: 'assistant.text',
      bytes: Buffer.byteLength(' 雪\n'),
      sha256: `sha256:${createHash('sha256').update(' 雪\n').digest('hex')}`,
      chunkCount: 1,
    },
  };
  const chunk = {
    observationId: 'obs_1',
    chunkIndex: 0,
    byteOffset: 0,
    encoding: 'base64',
    data: Buffer.from(' 雪\n').toString('base64'),
  };

  /** Builds a real append envelope without pre-validating its candidate payload. */
  function event(type: string, data: unknown) {
    return { schemaVersion: 1, kind: 'event', lineage, sequence: 7, event: { type, data } };
  }

  it('accepts typed metadata and exact Unicode content chunks under unchanged outer lineage', () => {
    for (const record of [
      event('observation.recorded', observation),
      event('observation.content.chunk', chunk),
    ]) {
      expect(WorkerCanonicalEventRecordSchema.parse(record)).toEqual(record);
      expect(WorkerTranscriptRecordSchema.parse(record)).toEqual(record);
    }
  });

  it.each([
    {
      kind: 'origin',
      runtimeOriginRef: 'origin_2',
      parentRuntimeOriginRef: 'origin_1',
      phase: 'started',
    },
    {
      kind: 'tool',
      runtimeOriginRef: null,
      phase: 'completed',
      callRef: 'call_1',
      toolName: 'functions.exec_command',
      exitCode: 0,
    },
    {
      kind: 'assistant',
      runtimeOriginRef: null,
      phase: 'completed',
      messageRef: 'message_1',
      representation: 'snapshot',
    },
    { kind: 'coverage', runtimeOriginRef: null, family: 'child-content', coverage: 'unsupported' },
    {
      kind: 'coverage',
      runtimeOriginRef: 'origin_1',
      family: 'primary-content',
      coverage: 'unavailable',
      reason: 'partial-frame',
    },
  ])('accepts independently reported facts without granting execution authority: $kind', (fact) => {
    const record = event('observation.recorded', {
      ...observation,
      fact,
      content: { state: 'not-applicable' },
    });
    expect(WorkerCanonicalEventRecordSchema.parse(record)).toEqual(record);
  });

  it.each([
    { state: 'off' },
    { state: 'not-applicable' },
    { state: 'unavailable', reason: 'unsupported' },
    { state: 'unavailable', reason: 'capture-failed' },
    { state: 'unavailable', reason: 'truncated' },
    { state: 'unavailable', reason: 'credential-excluded' },
    {
      ...observation.content,
      bytes: 0,
      chunkCount: 0,
      sha256: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    { ...observation.content, bytes: 16 * 1024 * 1024, chunkCount: 342 },
  ])('accepts explicit content admission states: $state', (content) => {
    const record = event('observation.recorded', { ...observation, content });
    expect(WorkerCanonicalEventRecordSchema.parse(record)).toEqual(record);
  });

  it.each([
    { ...observation, body: 'private body' },
    { ...observation, sourceRef: '/home/runtime/native.jsonl' },
    { ...observation, observationId: '' },
    { ...observation, sourceSequence: -1 },
    { ...observation, sourceSequence: 0.5 },
    { ...observation, sourceSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...observation, observedAt: 'yesterday' },
    { ...observation, sourceTimestamp: 'yesterday' },
    { ...observation, fact: { ...observation.fact, nativeThreadId: 'native_1' } },
    { ...observation, fact: { ...observation.fact, label: 'user label' } },
    { ...observation, fact: { ...observation.fact, runtimeOriginRef: undefined } },
    { ...observation, fact: { ...observation.fact, runtimeOriginRef: '/native/thread' } },
    { ...observation, fact: { ...observation.fact, toolName: 'exec' } },
    { ...observation, fact: { ...observation.fact, parentRuntimeOriginRef: 'origin_2' } },
    { ...observation, fact: { ...observation.fact, coverage: 'ended' } },
    { ...observation, fact: { ...observation.fact, phase: undefined } },
    { ...observation, fact: { ...observation.fact, messageRef: undefined } },
    { ...observation, fact: { ...observation.fact, representation: undefined } },
    {
      ...observation,
      fact: {
        kind: 'origin',
        runtimeOriginRef: 'origin_1',
        parentRuntimeOriginRef: 'origin_1',
        phase: 'started',
      },
    },
    {
      ...observation,
      fact: {
        kind: 'tool',
        runtimeOriginRef: null,
        phase: 'started',
        callRef: 'call_1',
        exitCode: 0,
      },
    },
    {
      ...observation,
      fact: {
        kind: 'tool',
        runtimeOriginRef: null,
        phase: 'started',
        callRef: 'call_1',
        toolName: 'exec failed: secret value',
      },
    },
    {
      ...observation,
      fact: {
        kind: 'tool',
        runtimeOriginRef: null,
        phase: 'started',
        callRef: 'call_1',
        toolName: 'x'.repeat(129),
      },
    },
    {
      ...observation,
      fact: {
        kind: 'coverage',
        runtimeOriginRef: null,
        family: 'child-content',
        coverage: 'collecting',
        reason: 'collector-failed',
      },
      content: { state: 'not-applicable' },
    },
    {
      ...observation,
      fact: {
        kind: 'coverage',
        runtimeOriginRef: null,
        family: 'child-content',
        coverage: 'unavailable',
      },
      content: { state: 'not-applicable' },
    },
    {
      ...observation,
      fact: { kind: 'coverage', runtimeOriginRef: null, coverage: 'ended' },
      content: { state: 'not-applicable' },
    },
    { ...observation, fact: { kind: 'origin', runtimeOriginRef: 'origin_1', phase: 'started' } },
  ])('rejects malformed metadata and incompatible fact fields %#', (data) => {
    expect(
      WorkerCanonicalEventRecordSchema.safeParse(event('observation.recorded', data)).success
    ).toBe(false);
  });

  it.each([
    { state: 'off', body: 'private' },
    { state: 'unavailable', reason: 'arbitrary exception' },
    { ...observation.content, bytes: -1 },
    { ...observation.content, bytes: 0.5 },
    { ...observation.content, bytes: 16 * 1024 * 1024 + 1 },
    { ...observation.content, bytes: 0, chunkCount: 1 },
    { ...observation.content, chunkCount: 0 },
    { ...observation.content, chunkCount: 7 },
    { ...observation.content, bytes: 48 * 1024 + 1, chunkCount: 1 },
    { ...observation.content, sha256: 'sha256:ABC' },
    { ...observation.content, sha256: `sha256:${'A'.repeat(64)}` },
    { ...observation.content, mediaType: 'text/html' },
    { ...observation.content, boundary: '/home/native-file' },
    { ...observation.content, boundary: '' },
  ])('rejects invalid or impossible content descriptors %#', (content) => {
    expect(
      WorkerCanonicalEventRecordSchema.safeParse(
        event('observation.recorded', { ...observation, content })
      ).success
    ).toBe(false);
  });

  it('rejects fact conflicts independently of content admission', () => {
    const origin = { kind: 'origin', runtimeOriginRef: 'origin_1', phase: 'started' };
    expect(WorkerObservationFactSchema.parse(origin)).toEqual(origin);
    for (const fact of [
      { ...origin, parentRuntimeOriginRef: 'origin_1' },
      { ...origin, runtimeOriginRef: null, parentRuntimeOriginRef: 'origin_2' },
      { ...origin, callRef: 'call_1' },
      { ...origin, phase: undefined },
      { kind: 'tool', runtimeOriginRef: null, phase: 'started' },
      {
        kind: 'tool',
        runtimeOriginRef: null,
        phase: 'completed',
        callRef: 'call_1',
        exitCode: 0.5,
      },
      {
        kind: 'coverage',
        runtimeOriginRef: null,
        family: 'child-content',
        coverage: 'ended',
        phase: 'completed',
      },
    ]) {
      expect(WorkerObservationFactSchema.safeParse(fact).success).toBe(false);
    }
  });

  it('keeps transport sequence distinct from source order and never accepts body text as metadata', () => {
    expect(WorkerObservationDataSchema.parse(observation).sourceSequence).toBe(0);
    const record = event('observation.recorded', observation);
    expect(WorkerCanonicalEventRecordSchema.parse(record).sequence).toBe(7);
    for (const bodyField of ['body', 'arguments', 'result', 'text', 'reasoning', 'path']) {
      expect(
        WorkerObservationDataSchema.safeParse({
          ...observation,
          fact: { ...observation.fact, [bodyField]: 'excluded' },
        }).success
      ).toBe(false);
    }
  });

  it('accepts canonical padding and later chunk coordinates without imposing fixed chunk sizes', () => {
    for (const bytes of [
      Buffer.from([255]),
      Buffer.from([255, 254]),
      Buffer.from([255, 254, 253]),
    ]) {
      const data = { ...chunk, chunkIndex: 1, byteOffset: 5, data: bytes.toString('base64') };
      expect(WorkerObservationContentChunkDataSchema.parse(data)).toEqual(data);
      expect(Buffer.from(data.data, 'base64')).toEqual(bytes);
    }
    const finalByte = { ...chunk, chunkIndex: 341, byteOffset: 16 * 1024 * 1024 - 1, data: '/w==' };
    expect(WorkerObservationContentChunkDataSchema.safeParse(finalByte).success).toBe(false);
    const validFinalByte = { ...finalByte, chunkIndex: 342 };
    expect(WorkerObservationContentChunkDataSchema.parse(validFinalByte)).toEqual(validFinalByte);
    expect(
      WorkerObservationContentChunkDataSchema.safeParse({ ...validFinalByte, data: '//8=' }).success
    ).toBe(false);
  });

  it('accepts a maximum-size chunk and source-local timestamp without rewriting bytes', () => {
    const record = event('observation.content.chunk', {
      ...chunk,
      data: Buffer.alloc(48 * 1024, 255).toString('base64'),
    });
    expect(WorkerCanonicalEventRecordSchema.parse(record)).toEqual(record);
    const metadata = event('observation.recorded', {
      ...observation,
      sourceTimestamp: '2026-09-22T01:00:00.000+01:00',
    });
    expect(WorkerCanonicalEventRecordSchema.parse(metadata)).toEqual(metadata);
  });

  it.each([
    { ...chunk, chunkIndex: -1 },
    { ...chunk, chunkIndex: 0.5 },
    { ...chunk, byteOffset: -1 },
    { ...chunk, byteOffset: 0.5 },
    { ...chunk, byteOffset: Number.MAX_SAFE_INTEGER + 1 },
    { ...chunk, byteOffset: 16 * 1024 * 1024 },
    { ...chunk, byteOffset: 1 },
    { ...chunk, chunkIndex: 1 },
    { ...chunk, data: '' },
    { ...chunk, data: 'YQ' },
    { ...chunk, data: 'YQ==\n' },
    { ...chunk, data: 'YR==' },
    { ...chunk, data: 'YWJ=' },
    { ...chunk, data: '_w==' },
    { ...chunk, data: '!!!!' },
    { ...chunk, data: Buffer.alloc(48 * 1024 + 1).toString('base64') },
    { ...chunk, encoding: 'utf8' },
    { ...chunk, secret: 'unexpected' },
  ])('rejects noncanonical or invalid bounded chunks %#', (data) => {
    expect(
      WorkerCanonicalEventRecordSchema.safeParse(event('observation.content.chunk', data)).success
    ).toBe(false);
  });
});

describe('worker protocol schemas', () => {
  it('accepts complete worker lineage and rejects missing scope fields', () => {
    expect(WorkerLineageSchema.parse(lineage)).toEqual(lineage);

    expect(() =>
      WorkerLineageSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        packageSnapshotId: 'aep_demo',
      })
    ).toThrow();
  });

  it('accepts canonical event append records with closed event types', () => {
    const parsed = WorkerCanonicalEventRecordSchema.parse({
      schemaVersion: 1,
      kind: 'event',
      lineage,
      sequence: 3,
      event: {
        type: 'item.delta',
        data: {
          itemId: 'it_candidate',
          delta: 'hello',
        },
      },
    });

    expect(parsed.event.type).toBe('item.delta');
    expect(() =>
      WorkerCanonicalEventRecordSchema.parse({
        schemaVersion: 1,
        kind: 'event',
        lineage,
        sequence: 4,
        event: {
          type: 'shell.exec',
          data: {},
        },
      })
    ).toThrow();
  });

  it('rejects invalid worker sequence numbers', () => {
    expect(() =>
      WorkerCanonicalEventRecordSchema.parse({
        schemaVersion: 1,
        kind: 'event',
        lineage,
        sequence: -1,
        event: {
          type: 'worker.heartbeat',
          data: {},
        },
      })
    ).toThrow();
  });

  it('accepts transcript item and event records', () => {
    expect(
      WorkerTranscriptRecordSchema.parse({
        schemaVersion: 1,
        kind: 'item',
        lineage,
        sequence: 0,
        item: {
          type: 'assistant-message',
          status: 'completed',
          text: 'Done.',
        },
      }).kind
    ).toBe('item');

    expect(() =>
      WorkerTranscriptRecordSchema.parse({
        schemaVersion: 1,
        kind: 'artifact',
        lineage,
        sequence: 1,
        artifact: {
          kind: 'report',
          title: 'Research report',
          path: 'artifacts/report.md',
          mediaType: 'text/markdown',
        },
      })
    ).toThrow();

    expect(
      WorkerTranscriptRecordSchema.parse({
        schemaVersion: 1,
        kind: 'event',
        lineage,
        sequence: 2,
        event: {
          type: 'turn.completed',
          data: {
            evidenceManifestDigests: {},
            status: 'completed',
            stopReason: 'completed',
          },
        },
      }).kind
    ).toBe('event');
  });

  it('builds one strict canonical terminal event for transcript and final status paths', () => {
    const record = buildWorkerCanonicalTerminalEventRecord({
      data: {
        diagnostics: { stderr: 'Product-safe failure summary.' },
        evidenceManifestDigests: { runtime: 'sha256:runtime' },
        status: 'failed',
        stopReason: 'worker-runtime-failed',
      },
      lineage,
      sequence: 15,
    });

    expect(record).toEqual({
      event: {
        data: {
          diagnostics: { stderr: 'Product-safe failure summary.' },
          evidenceManifestDigests: { runtime: 'sha256:runtime' },
          status: 'failed',
          stopReason: 'worker-runtime-failed',
        },
        type: 'turn.failed',
      },
      kind: 'event',
      lineage,
      schemaVersion: 1,
      sequence: 15,
    });
    expect(
      buildWorkerCanonicalTerminalEventRecord({
        data: { status: 'completed', stopReason: 'completed' },
        lineage,
        sequence: 16,
      }).event
    ).toEqual({
      data: {
        evidenceManifestDigests: {},
        status: 'completed',
        stopReason: 'completed',
      },
      type: 'turn.completed',
    });
  });

  it('rejects non-canonical terminal event data at every schema boundary', () => {
    for (const data of [
      { evidenceManifestDigests: {}, stopReason: 'completed' },
      { evidenceManifestDigests: {}, status: 'completed', stopReason: '   ' },
      {
        evidenceManifestDigests: {},
        status: 'completed',
        stopReason: 'completed',
        unexpected: true,
      },
    ]) {
      expect(() => WorkerCanonicalTerminalEventDataSchema.parse(data)).toThrow();
      expect(() =>
        WorkerCanonicalEventRecordSchema.parse({
          event: { data, type: 'turn.completed' },
          kind: 'event',
          lineage,
          schemaVersion: 1,
          sequence: 17,
        })
      ).toThrow();
    }
  });

  it('rejects terminal event types that conflict with their status', () => {
    for (const [type, status] of [
      ['turn.completed', 'failed'],
      ['turn.failed', 'completed'],
    ] as const) {
      expect(() =>
        WorkerCanonicalEventRecordSchema.parse({
          event: {
            data: {
              evidenceManifestDigests: {},
              status,
              stopReason: 'terminal-status-mismatch',
            },
            type,
          },
          kind: 'event',
          lineage,
          schemaVersion: 1,
          sequence: 18,
        })
      ).toThrow();
    }
  });

  it('accepts capability call summaries without exposing secret payloads', () => {
    const parsed = WorkerCapabilityCallSummarySchema.parse({
      schemaVersion: 1,
      lineage,
      sequence: 9,
      capabilityCallId: 'cap_1',
      family: 'knowledge.search',
      status: 'succeeded',
      inputSummary: 'search workspace knowledge',
      outputSummary: '2 knowledge entries matched',
      policyRefId: 'policy_knowledge_read',
      startedAt: '2026-06-29T00:00:00.000Z',
      completedAt: '2026-06-29T00:00:01.000Z',
    });

    expect(parsed.family).toBe('knowledge.search');
    expect(() =>
      WorkerCapabilityCallSummarySchema.parse({
        schemaVersion: 1,
        lineage,
        sequence: 10,
        capabilityCallId: 'cap_2',
        family: 'vault.raw_secret',
        status: 'succeeded',
        inputSummary: 'read raw secret',
        outputSummary: 'secret value',
      })
    ).toThrow();
  });

  it('accepts bounded worker-control request and response envelopes', () => {
    expect(
      WorkerControlRequestEnvelopeSchema.parse({
        schemaVersion: 2,
        lineage,
        sequence: 11,
        operation: 'heartbeat',
        body: {
          status: 'running',
        },
      }).operation
    ).toBe('heartbeat');

    expect(() =>
      WorkerControlRequestEnvelopeSchema.parse({
        schemaVersion: 2,
        lineage,
        sequence: 12,
        operation: 'shell.exec',
        body: {
          command: 'rm -rf /',
        },
      })
    ).toThrow();

    expect(
      WorkerControlRequestEnvelopeSchema.parse({
        schemaVersion: 2,
        lineage,
        sequence: 13,
        operation: 'final_status',
        body: {},
      }).operation
    ).toBe('final_status');

    expect(
      WorkerControlResponseEnvelopeSchema.parse({
        schemaVersion: 2,
        accepted: true,
        nextExpectedSequence: 12,
        diagnostics: [],
      }).accepted
    ).toBe(true);
  });

  it('uses version 2 only for control envelopes while canonical records remain version 1', () => {
    const control = {
      schemaVersion: 2,
      lineage,
      sequence: 14,
      operation: 'heartbeat' as const,
      body: {},
    };
    const record = {
      schemaVersion: 1,
      lineage,
      sequence: 14,
      kind: 'event' as const,
      event: { type: 'worker.heartbeat' as const, data: {} },
    };

    expect(WorkerControlRequestEnvelopeSchema.parse(control)).toEqual(control);
    expect(() =>
      WorkerControlRequestEnvelopeSchema.parse({ ...control, schemaVersion: 1 })
    ).toThrow();
    expect(WorkerCanonicalEventRecordSchema.parse(record)).toEqual(record);
    expect(() => WorkerCanonicalEventRecordSchema.parse({ ...record, schemaVersion: 2 })).toThrow();
  });

  it('rejects retired control operations', () => {
    expect(WorkerControlOperationSchema.parse('final_status')).toBe('final_status');
    expect(() => WorkerControlOperationSchema.parse('command_poll')).toThrow();
    expect(() => WorkerControlOperationSchema.parse('command_ack')).toThrow();
    expect(() => WorkerControlHeartbeatStatusSchema.parse('awaiting_command')).toThrow();
    expect(() => WorkerControlOperationSchema.parse('knowledge_proposal_summary')).toThrow();
    expect(() => WorkerControlOperationSchema.parse('terminal_result')).toThrow();
  });

  it('requires the sequence-zero heartbeat to commit one process key hash', () => {
    const request = {
      body: {
        message: null,
        processKeyHash: Buffer.alloc(32, 1).toString('base64url'),
        status: 'starting' as const,
      },
      lineage,
      operation: 'heartbeat' as const,
      schemaVersion: 2 as const,
      sequence: 0,
    };

    expect(WorkerControlRequestEnvelopeSchema.parse(request)).toEqual(request);
    expect(WorkerControlHeartbeatRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      WorkerControlHeartbeatRequestSchema.parse({
        ...request,
        body: { message: null, status: 'starting' },
      })
    ).toThrow();
  });

  it('keeps the reconnect key outside the canonical heartbeat envelope', () => {
    const heartbeat = {
      body: { message: null, status: 'running' as const },
      lineage,
      operation: 'heartbeat' as const,
      schemaVersion: 2 as const,
      sequence: 7,
    };
    const reconnect = {
      ...heartbeat,
      reconnectKey: Buffer.alloc(32, 2).toString('base64url'),
    };

    expect(WorkerControlRequestEnvelopeSchema.parse(heartbeat)).toEqual(heartbeat);
    expect(() => WorkerControlRequestEnvelopeSchema.parse(reconnect)).toThrow();
    expect(WorkerControlHeartbeatRequestSchema.parse(reconnect)).toEqual(reconnect);
  });

  it('normalizes worker error envelopes', () => {
    const parsed = WorkerErrorEnvelopeSchema.parse({
      code: 'worker_sequence_conflict',
      message: 'Sequence already accepted.',
      retryable: false,
      diagnostics: [
        {
          code: 'sequence_conflict',
          message: 'Duplicate sequence has different content.',
          path: '$.sequence',
        },
      ],
    });

    expect(parsed.diagnostics[0]?.path).toBe('$.sequence');
  });

  it('accepts a bounded runtime provenance raw stream manifest', () => {
    const manifest = WorkerRuntimeRawStreamManifestSchema.parse({
      schemaVersion: 1,
      lineage,
      runtimeFamily: 'codex',
      adapterVersion: '0.153.4',
      primaryStreamRef: 'stream-0000.jsonl',
      captureStatus: 'complete',
      streams: [
        {
          streamRef: 'stream-0000.jsonl',
          sourceKind: 'primary',
          bytes: 128,
          sha256: `sha256:${'a'.repeat(64)}`,
          frameCount: 2,
          captureStatus: 'complete',
          stableTerminal: true,
        },
        {
          streamRef: 'stream-0001.jsonl',
          sourceKind: 'runtime-thread',
          bytes: 256,
          sha256: `sha256:${'b'.repeat(64)}`,
          frameCount: 3,
          captureStatus: 'complete',
          stableTerminal: true,
        },
      ],
    });

    expect(WorkerRuntimeProvenanceFeatureSchema.parse('worker.runtime-provenance.v1')).toBe(
      'worker.runtime-provenance.v1'
    );
    expect(manifest.primaryStreamRef).toBe('stream-0000.jsonl');
    expect(manifest.streams).toHaveLength(2);
  });

  it('rejects unsafe, duplicate, or inconsistent runtime stream declarations', () => {
    const stream = {
      streamRef: 'stream-0000.jsonl',
      sourceKind: 'primary',
      bytes: 1,
      sha256: `sha256:${'a'.repeat(64)}`,
      frameCount: 1,
      captureStatus: 'complete',
      stableTerminal: true,
    };
    const manifest = {
      schemaVersion: 1,
      lineage,
      runtimeFamily: 'codex',
      adapterVersion: '0.153.4',
      primaryStreamRef: 'stream-0000.jsonl',
      captureStatus: 'complete',
      streams: [stream],
    };

    for (const candidate of [
      { ...manifest, primaryStreamRef: '../native-thread.jsonl' },
      { ...manifest, streams: [stream, stream] },
      { ...manifest, streams: [{ ...stream, sourceKind: 'runtime-thread' }] },
      { ...manifest, streams: [{ ...stream, sha256: 'sha256:short' }] },
      { ...manifest, streams: [{ ...stream, bytes: -1 }] },
      { ...manifest, streams: [{ ...stream, stableTerminal: false }] },
      { ...manifest, streams: [{ ...stream, captureStatus: 'truncated' }] },
      {
        ...manifest,
        primaryStreamRef: 'stream-0001.jsonl',
        streams: [{ ...stream, streamRef: 'stream-0001.jsonl' }],
      },
    ]) {
      expect(() => WorkerRuntimeRawStreamManifestSchema.parse(candidate)).toThrow();
    }
  });

  it('accepts parsed, malformed, and truncated native origin index entries', () => {
    const base = {
      schemaVersion: 1,
      lineage,
      runtimeFamily: 'codex',
      adapterVersion: '0.153.4',
      streamRef: 'stream-0001.jsonl',
      frameSequence: 2,
      byteOffset: 128,
      byteLength: 64,
      frameSha256: `sha256:${'c'.repeat(64)}`,
      eventKind: 'response.output_item.done',
    };
    const parsed = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      ...base,
      parseStatus: 'parsed',
      nativeSessionId: 'session-native',
      nativeThreadId: 'thread-child',
      parentNativeThreadId: 'thread-root',
      nativeTurnId: 'turn-native',
      runtimeRole: 'worker',
      runtimeNickname: 'researcher',
      runtimeDepth: 1,
    });
    const root = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      ...base,
      streamRef: 'stream-0000.jsonl',
      frameSequence: 0,
      byteOffset: 0,
      parseStatus: 'parsed',
      nativeSessionId: 'session-native',
      nativeThreadId: 'thread-root',
      nativeTurnId: 'turn-native',
      runtimeRole: 'coordinator',
      runtimeDepth: 0,
    });
    const malformed = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      ...base,
      frameSequence: 3,
      parseStatus: 'malformed',
    });
    const truncated = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      ...base,
      frameSequence: 4,
      parseStatus: 'truncated',
    });

    expect(parsed.nativeThreadId).toBe('thread-child');
    expect(root.parentNativeThreadId).toBeUndefined();
    expect(malformed.parseStatus).toBe('malformed');
    expect(truncated.parseStatus).toBe('truncated');
  });

  it('rejects invalid native origin frame coordinates and restricted field drift', () => {
    const entry = {
      schemaVersion: 1,
      lineage,
      runtimeFamily: 'codex',
      adapterVersion: '0.153.4',
      streamRef: 'stream-0001.jsonl',
      frameSequence: 0,
      byteOffset: 0,
      byteLength: 1,
      frameSha256: `sha256:${'d'.repeat(64)}`,
      eventKind: 'thread.started',
      parseStatus: 'parsed',
      nativeThreadId: 'thread-root',
      runtimeDepth: 0,
    };

    for (const candidate of [
      { ...entry, streamRef: 'thread-root.jsonl' },
      { ...entry, byteOffset: -1 },
      { ...entry, byteLength: 0 },
      { ...entry, frameSha256: 'sha256:not-a-digest' },
      { ...entry, runtimeDepth: -1 },
      { ...entry, nativeWorkspaceId: 'ws_spoofed' },
    ]) {
      expect(() => WorkerRuntimeNativeOriginIndexEntrySchema.parse(candidate)).toThrow();
    }
  });
});

describe('descriptive reader extensions', () => {
  const event = {
    schemaVersion: 1,
    kind: 'event',
    lineage,
    sequence: 1,
    event: { type: 'worker.ready', data: {} },
  };
  const observation = {
    observationId: 'obs_extension',
    sourceRef: 'source_1',
    sourceSequence: 0,
    observedAt: '2026-10-06T00:00:00.000Z',
    fact: {
      kind: 'assistant',
      runtimeOriginRef: null,
      phase: 'completed',
      messageRef: 'message_1',
    },
    content: { state: 'off' },
  };
  const stream = {
    streamRef: 'stream-0000.jsonl',
    sourceKind: 'primary',
    bytes: 1,
    sha256: `sha256:${'a'.repeat(64)}`,
    frameCount: 1,
    captureStatus: 'complete',
    stableTerminal: true,
  };
  const cases = [
    {
      name: 'refresh acknowledgement',
      schema: WorkerControlSupplyRefreshAckBodyReaderSchema,
      emitter: WorkerControlSupplyRefreshAckBodySchema,
      value: { refreshId: 'refresh_1', status: 'applied' },
      core: 'status',
    },
    {
      name: 'event',
      schema: WorkerCanonicalEventRecordReaderSchema,
      emitter: WorkerCanonicalEventRecordSchema,
      value: event,
      core: 'kind',
    },
    {
      name: 'transcript',
      schema: WorkerTranscriptRecordSchema,
      emitter: WorkerTranscriptItemRecordEmissionSchema,
      value: {
        schemaVersion: 1,
        kind: 'item',
        lineage,
        sequence: 1,
        item: {
          type: 'assistant-message',
          status: 'completed',
          parts: [{ type: 'text', text: 'done' }],
        },
      },
      core: 'kind',
    },
    {
      name: 'observation',
      schema: WorkerObservationDataReaderSchema,
      emitter: WorkerObservationDataSchema,
      value: observation,
      core: 'sourceRef',
    },
    {
      name: 'chunk',
      schema: WorkerObservationContentChunkDataReaderSchema,
      emitter: WorkerObservationContentChunkDataSchema,
      value: {
        observationId: 'obs_extension',
        chunkIndex: 0,
        byteOffset: 0,
        encoding: 'base64',
        data: 'YQ==',
      },
      core: 'encoding',
    },
    {
      name: 'manifest',
      schema: WorkerRuntimeRawStreamManifestReaderSchema,
      emitter: WorkerRuntimeRawStreamManifestSchema,
      value: {
        schemaVersion: 1,
        lineage,
        runtimeFamily: 'codex',
        adapterVersion: '0.153.4',
        primaryStreamRef: 'stream-0000.jsonl',
        captureStatus: 'complete',
        streams: [stream],
      },
      core: 'captureStatus',
    },
    {
      name: 'native index',
      schema: WorkerRuntimeNativeOriginIndexEntryReaderSchema,
      emitter: WorkerRuntimeNativeOriginIndexEntrySchema,
      value: {
        schemaVersion: 1,
        lineage,
        runtimeFamily: 'codex',
        adapterVersion: '0.153.4',
        streamRef: 'stream-0000.jsonl',
        frameSequence: 0,
        byteOffset: 0,
        byteLength: 1,
        frameSha256: `sha256:${'a'.repeat(64)}`,
        eventKind: 'thread.started',
        parseStatus: 'parsed',
      },
      core: 'parseStatus',
    },
    {
      name: 'capability',
      schema: WorkerCapabilityCallSummaryReaderSchema,
      emitter: WorkerCapabilityCallSummarySchema,
      value: {
        schemaVersion: 1,
        lineage,
        sequence: 1,
        capabilityCallId: 'cap_1',
        family: 'knowledge.search',
        status: 'succeeded',
        inputSummary: 'search',
        diagnostics: [],
      },
      core: 'family',
    },
    {
      name: 'heartbeat',
      schema: WorkerControlHeartbeatRequestReaderSchema,
      emitter: WorkerControlHeartbeatRequestSchema,
      value: {
        schemaVersion: 2,
        lineage,
        sequence: 1,
        operation: 'heartbeat',
        body: { status: 'running' },
      },
      core: 'operation',
    },
    {
      name: 'request',
      schema: WorkerControlRequestEnvelopeReaderSchema,
      emitter: WorkerControlRequestEnvelopeSchema,
      value: {
        schemaVersion: 2,
        lineage,
        sequence: 1,
        operation: 'final_status',
        body: {},
      },
      core: 'operation',
    },
    {
      name: 'response',
      schema: WorkerControlResponseEnvelopeReaderSchema,
      emitter: WorkerControlResponseEnvelopeSchema,
      value: {
        schemaVersion: 2,
        accepted: true,
        diagnostics: [],
      },
      core: 'accepted',
    },
    {
      name: 'error',
      schema: WorkerErrorEnvelopeReaderSchema,
      emitter: WorkerErrorEnvelopeSchema,
      value: {
        code: 'worker_failed',
        message: 'failed',
        retryable: false,
        diagnostics: [],
      },
      core: 'code',
    },
    {
      name: 'terminal',
      schema: WorkerCanonicalTerminalEventDataReaderSchema,
      emitter: WorkerCanonicalTerminalEventDataSchema,
      value: {
        status: 'completed',
        stopReason: 'completed',
        evidenceManifestDigests: {},
      },
      core: 'status',
    },
  ];
  it.each(cases)('strips inert additions from $name before use', ({ schema, value }) => {
    expect(schema.parse({ ...value, futureNote: 'ignored' })).toEqual(value);
  });
  it.each(cases)('refuses unsupported required semantics in $name', ({ schema, value }) => {
    expect(schema.safeParse({ ...value, requiredFeatures: ['unsupported.required'] }).success).toBe(
      false
    );
  });
  it('refuses unsupported requirements in nested descriptive members', () => {
    const requiredFeatures = ['unsupported.required'];
    expect(
      WorkerCanonicalEventRecordReaderSchema.safeParse({
        ...event,
        event: { ...event.event, requiredFeatures },
      }).success
    ).toBe(false);
    const item = {
      type: 'assistant-message',
      status: 'completed',
      parts: [{ type: 'text', text: 'done' }],
    };
    const record = { schemaVersion: 1, kind: 'item', lineage, sequence: 1, item };
    for (const candidate of [
      { ...record, item: { ...item, requiredFeatures } },
      { ...record, item: { ...item, parts: [{ ...item.parts[0], requiredFeatures }] } },
    ]) {
      expect(WorkerTranscriptRecordSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      WorkerRuntimeRawStreamManifestReaderSchema.safeParse({
        schemaVersion: 1,
        lineage,
        runtimeFamily: 'codex',
        adapterVersion: '0.153.4',
        primaryStreamRef: stream.streamRef,
        captureStatus: 'complete',
        streams: [{ ...stream, requiredFeatures }],
      }).success
    ).toBe(false);
  });
  it('refuses reconnect proof outside its request-only heartbeat slot', () => {
    const key = Buffer.alloc(32, 2).toString('base64url');
    const heartbeat = {
      schemaVersion: 2,
      lineage,
      sequence: 1,
      operation: 'heartbeat',
      body: { status: 'running' },
    };
    expect(
      WorkerControlRequestEnvelopeReaderSchema.safeParse({ ...heartbeat, reconnectKey: key })
        .success
    ).toBe(false);
    expect(
      WorkerControlHeartbeatRequestReaderSchema.safeParse({
        ...heartbeat,
        body: { ...heartbeat.body, reconnectKey: key },
      }).success
    ).toBe(false);
  });
  it('refuses worker-supplied actor authority on reporting envelopes', () => {
    for (const schema of [
      WorkerControlHeartbeatRequestReaderSchema,
      WorkerControlRequestEnvelopeReaderSchema,
    ]) {
      const value = {
        schemaVersion: 2,
        lineage,
        sequence: 1,
        operation: 'heartbeat',
        body: { status: 'running' },
      };
      expect(
        schema.safeParse({ ...value, actor: { kind: 'user', id: 'user_spoofed' } }).success
      ).toBe(false);
      expect(schema.safeParse({ ...value, responsibleUserId: 'user_spoofed' }).success).toBe(false);
    }
  });
  it.each(cases)('keeps exact producer assertions for $name', ({ emitter, value }) => {
    expect(emitter.parse(value)).toEqual(value);
    expect(emitter.safeParse({ ...value, futureNote: 'producer typo' }).success).toBe(false);
  });
  it.each(cases)('still refuses missing core in $name', ({ schema, value, core }) => {
    const candidate: Record<string, unknown> = { ...value, futureNote: 'ignored' };
    delete candidate[core];
    expect(schema.safeParse(candidate).success).toBe(false);
  });
  it('strips nested descriptive additions while retaining observation constraints', () => {
    expect(
      WorkerObservationDataReaderSchema.parse({
        ...observation,
        fact: { ...observation.fact, futureNote: true },
        content: { ...observation.content, futureNote: true },
      })
    ).toEqual(observation);
    expect(
      WorkerObservationDataReaderSchema.safeParse({
        ...observation,
        fact: { ...observation.fact, phase: 'invented' },
      }).success
    ).toBe(false);
  });
});
