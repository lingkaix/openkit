import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerTranscriptRecordSchema } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import { type WorkerLineage, WorkerTranscriptWriter } from './transcript.js';

const lineage: WorkerLineage = {
  agentSessionId: 'as_worker_1',
  packageSnapshotId: 'aepsnap_worker_1',
  requestId: 'req_worker_1',
  threadId: 'th_demo',
  turnId: 'turn_worker_1',
  workspaceId: 'ws_demo',
};

describe('WorkerTranscriptWriter', () => {
  it('writes durable event, item, artifact, and terminal records with lineage', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-'));
    const writer = new WorkerTranscriptWriter({ lineage, sessionDir });

    await writer.writeEvent({
      data: { pid: 123 },
      type: 'worker.ready',
    });
    await writer.writeAssistantMessage({
      parts: [{ text: 'Worker completed the task.', type: 'text' }],
      status: 'completed',
    });
    await writer.writeArtifact({
      kind: 'file',
      mediaType: 'text/markdown',
      path: '/workspace/output/summary.md',
      title: 'Patch Summary',
    });
    const terminalRecord = await writer.writeTerminalOutcome({
      status: 'completed',
    });

    const events = readJsonl(join(sessionDir, 'events.jsonl'));
    const items = readJsonl(join(sessionDir, 'items.jsonl'));
    const artifacts = readJsonl(join(sessionDir, 'artifacts.jsonl'));

    expect(events).toEqual([
      expect.objectContaining({
        lineage,
        event: {
          data: { pid: 123 },
          type: 'worker.ready',
        },
        kind: 'event',
        schemaVersion: 1,
        sequence: 0,
      }),
      expect.objectContaining({
        lineage,
        event: {
          data: { status: 'completed' },
          type: 'turn.completed',
        },
        kind: 'event',
        schemaVersion: 1,
        sequence: 3,
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        lineage,
        item: {
          parts: [{ text: 'Worker completed the task.', type: 'text' }],
          status: 'completed',
          type: 'assistant-message',
        },
        kind: 'item',
        schemaVersion: 1,
        sequence: 1,
      }),
    ]);
    expect(artifacts).toEqual([
      expect.objectContaining({
        lineage,
        artifact: {
          kind: 'file',
          mediaType: 'text/markdown',
          path: '/workspace/output/summary.md',
          title: 'Patch Summary',
        },
        kind: 'artifact',
        schemaVersion: 1,
        sequence: 2,
      }),
    ]);
    for (const record of [...events, ...items, ...artifacts]) {
      expect(WorkerTranscriptRecordSchema.safeParse(record).success).toBe(true);
    }
    expect(terminalRecord).toEqual(events.at(-1));
  });
});

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
