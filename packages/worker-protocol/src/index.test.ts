import { describe, expect, it } from 'vitest';
import {
  buildWorkerCanonicalTerminalEventRecord,
  WorkerCanonicalEventRecordSchema,
  WorkerCanonicalTerminalEventDataSchema,
  WorkerCapabilityCallSummarySchema,
  WorkerControlHeartbeatRequestSchema,
  WorkerControlOperationSchema,
  WorkerControlRequestEnvelopeSchema,
  WorkerControlResponseEnvelopeSchema,
  WorkerErrorEnvelopeSchema,
  WorkerLineageSchema,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  WorkerRuntimeProvenanceFeatureSchema,
  WorkerRuntimeRawStreamManifestSchema,
  WorkerTranscriptRecordSchema,
  WorkerWorkspaceChangeManifestSchema,
} from './index.js';

const lineage = {
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  turnId: 'turn_demo',
  agentSessionId: 'as_demo',
  packageSnapshotId: 'aep_demo',
  requestId: 'req_demo',
};

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

  it('accepts transcript item, artifact, and event records', () => {
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

    expect(
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
      }).kind
    ).toBe('artifact');

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

  it('keeps material proposals optional and validates their exact shape', () => {
    const artifact = {
      kind: 'file',
      mediaType: 'text/plain',
      path: '/workspace/output/notes.txt',
      title: 'Material notes',
    };
    const record = {
      artifact,
      kind: 'artifact',
      lineage,
      schemaVersion: 1,
      sequence: 3,
    };

    expect(WorkerTranscriptRecordSchema.parse(record).kind).toBe('artifact');
    expect(
      WorkerTranscriptRecordSchema.parse({
        ...record,
        artifact: {
          ...artifact,
          materialProposal: {
            baseContentDigest: `sha256:${'b'.repeat(64)}`,
            baseRevisionId: 'matrev_1',
            materialId: 'mat_1',
          },
        },
      })
    ).toMatchObject({ artifact: { materialProposal: { materialId: 'mat_1' } } });

    for (const materialProposal of [
      {
        baseContentDigest: `sha256:${'b'.repeat(63)}`,
        baseRevisionId: 'matrev_1',
        materialId: 'mat_1',
      },
      {
        baseContentDigest: `sha256:${'b'.repeat(64)}`,
        baseRevisionId: 'matrev_1',
        materialId: 'mat_1',
        unexpected: true,
      },
      {
        baseContentDigest: `sha256:${'b'.repeat(64)}`,
        materialId: 'mat_1',
      },
    ]) {
      expect(() =>
        WorkerTranscriptRecordSchema.parse({
          ...record,
          artifact: { ...artifact, materialProposal },
        })
      ).toThrow();
    }
  });

  it('requires the closed Artifact kind and media type declarations', () => {
    const record = {
      artifact: {
        kind: 'file',
        mediaType: 'text/plain',
        path: '/workspace/output/notes.txt',
        title: 'Material notes',
      },
      kind: 'artifact',
      lineage,
      schemaVersion: 1,
      sequence: 4,
    };

    for (const artifact of [
      { ...record.artifact, kind: undefined },
      { ...record.artifact, kind: 'image' },
      { ...record.artifact, mediaType: undefined },
      { ...record.artifact, mediaType: null },
      { ...record.artifact, mediaType: 'image/png' },
    ]) {
      expect(() => WorkerTranscriptRecordSchema.parse({ ...record, artifact })).toThrow();
    }
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

  it('accepts workspace change manifests and rejects unsafe paths', () => {
    expect(
      WorkerWorkspaceChangeManifestSchema.parse({
        schemaVersion: 1,
        lineage,
        sequence: 7,
        base: {
          commit: 'abc123',
          contentDigest: 'sha256:base',
        },
        changes: [
          {
            path: 'src/index.ts',
            status: 'modified',
            digest: 'sha256:file',
          },
        ],
        bundleDigest: 'sha256:bundle',
      }).changes[0]?.path
    ).toBe('src/index.ts');

    for (const path of ['/etc/passwd', '../escape.txt', 'src/../../escape.txt']) {
      expect(() =>
        WorkerWorkspaceChangeManifestSchema.parse({
          schemaVersion: 1,
          lineage,
          sequence: 8,
          changes: [
            {
              path,
              status: 'modified',
            },
          ],
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
        schemaVersion: 1,
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
        schemaVersion: 1,
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
        schemaVersion: 1,
        lineage,
        sequence: 13,
        operation: 'command_ack',
        body: {
          commandId: 'worker-command-1',
        },
      }).operation
    ).toBe('command_ack');

    expect(
      WorkerControlResponseEnvelopeSchema.parse({
        schemaVersion: 1,
        accepted: true,
        nextExpectedSequence: 12,
        diagnostics: [],
      }).accepted
    ).toBe(true);
  });

  it('rejects retired control operations', () => {
    expect(WorkerControlOperationSchema.parse('command_ack')).toBe('command_ack');
    expect(WorkerControlOperationSchema.parse('final_status')).toBe('final_status');
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
      schemaVersion: 1 as const,
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
      schemaVersion: 1 as const,
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
      adapterVersion: '0.144.1',
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
      adapterVersion: '0.144.1',
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
      adapterVersion: '0.144.1',
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
      adapterVersion: '0.144.1',
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
