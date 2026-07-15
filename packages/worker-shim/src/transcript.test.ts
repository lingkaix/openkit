import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerTranscriptRecordSchema } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { type WorkerLineage, WorkerTranscriptWriter } from './transcript.js';

const appendControl = vi.hoisted(() => ({
  completed: [] as string[],
  holdNext: false,
  release: null as (() => void) | null,
  secondCompleted: null as (() => void) | null,
  total: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      const call = ++appendControl.total;

      if (appendControl.holdNext) {
        appendControl.holdNext = false;
        await new Promise<void>((resolve) => {
          appendControl.release = resolve;
        });
      }
      const result = await actual.appendFile(...args);
      appendControl.completed.push(String(args[1]));
      if (call === 2) {
        appendControl.secondCompleted?.();
      }
      return result;
    },
    mkdir: async () => undefined,
  };
});

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

    const readyRecord = await writer.writeAndAppendEvent({
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
      stopReason: 'completed',
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
          data: {
            evidenceManifestDigests: {},
            status: 'completed',
            stopReason: 'completed',
          },
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
    expect(readyRecord).toEqual(events[0]);
    expect(terminalRecord).toEqual(events.at(-1));
  });

  it('waits for an in-flight event append before writing the terminal record', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-terminal-order-'));
    const writer = new WorkerTranscriptWriter({ lineage, sessionDir });
    appendControl.completed = [];
    appendControl.holdNext = true;
    appendControl.release = null;
    appendControl.total = 0;
    let markSecondCompleted: (() => void) | undefined;
    const secondCompleted = new Promise<void>((resolve) => {
      markSecondCompleted = resolve;
    });
    appendControl.secondCompleted = markSecondCompleted ?? null;

    const eventWrite = writer.writeAndAppendEvent({
      data: { status: 'running' },
      type: 'worker.heartbeat',
    });
    await vi.waitFor(() => expect(appendControl.release).toBeTypeOf('function'));
    const terminalWrite = writer.writeTerminalOutcome({
      status: 'completed',
      stopReason: 'completed',
    });

    for (let turn = 0; turn < 5 && appendControl.total === 1; turn += 1) {
      await Promise.resolve();
    }
    if (appendControl.total === 2) {
      await secondCompleted;
    }
    appendControl.release?.();
    const terminalRecord = await terminalWrite;
    await eventWrite;

    const events = readJsonl(join(sessionDir, 'events.jsonl'));
    expect(events).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ type: 'worker.heartbeat' }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: 'turn.completed' }) }),
    ]);
    expect(terminalRecord).toEqual(events.at(-1));
  });

  it('waits for live acceptance before committing the terminal transcript record', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-live-order-'));
    let markLiveStarted: (() => void) | undefined;
    let releaseLive: (() => void) | undefined;
    const liveStarted = new Promise<void>((resolve) => {
      markLiveStarted = resolve;
    });
    const liveRelease = new Promise<void>((resolve) => {
      releaseLive = resolve;
    });
    const writer = new WorkerTranscriptWriter({
      appendEvent: async () => {
        markLiveStarted?.();
        await liveRelease;
      },
      lineage,
      sessionDir,
    });

    const readyWrite = writer.writeAndAppendEvent({ type: 'worker.ready' });
    await Promise.race([
      liveStarted,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Live event append did not start.')), 50)
      ),
    ]);
    const terminalWrite = writer.writeTerminalOutcome({
      status: 'completed',
      stopReason: 'completed',
    });

    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toHaveLength(1);
    releaseLive?.();
    await readyWrite;
    await terminalWrite;
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toHaveLength(2);
  });

  it('poisons the append queue after live rejection and never writes a terminal record', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-worker-shim-live-rejected-'));
    const writer = new WorkerTranscriptWriter({
      appendEvent: async () => {
        throw new Error('Live event rejected.');
      },
      lineage,
      sessionDir,
    });

    await expect(writer.writeAndAppendEvent({ type: 'worker.ready' })).rejects.toThrow(
      'Live event rejected.'
    );
    await expect(
      writer.writeTerminalOutcome({ status: 'completed', stopReason: 'completed' })
    ).rejects.toThrow('Live event rejected.');

    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ type: 'worker.ready' }) }),
    ]);
  });
});

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
