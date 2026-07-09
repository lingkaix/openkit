import { describe, expect, it } from 'vitest';
import {
  WorkerCanonicalEventRecordSchema,
  WorkerCapabilityCallSummarySchema,
  WorkerControlRequestEnvelopeSchema,
  WorkerControlResponseEnvelopeSchema,
  WorkerErrorEnvelopeSchema,
  WorkerLineageSchema,
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
            stopReason: 'completed',
          },
        },
      }).kind
    ).toBe('event');
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
      WorkerControlRequestEnvelopeSchema.parse({
        schemaVersion: 1,
        lineage,
        sequence: 14,
        operation: 'knowledge_proposal_summary',
        body: {
          proposalCount: 1,
        },
      }).operation
    ).toBe('knowledge_proposal_summary');

    expect(
      WorkerControlResponseEnvelopeSchema.parse({
        schemaVersion: 1,
        accepted: true,
        nextExpectedSequence: 12,
        diagnostics: [],
      }).accepted
    ).toBe(true);
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
});
