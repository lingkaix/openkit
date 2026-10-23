import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerCanonicalEventRecord } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { emitRuntimeFact, type RuntimeObservation } from './runtime-capture.js';
import { type WorkerLineage, WorkerTranscriptWriter } from './transcript.js';

const lineage: WorkerLineage = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  threadId: 'th_00000000-0000-7000-8000-000000000001',
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
  agentSessionId: 'as_00000000-0000-7000-8000-000000000001',
  packageSnapshotId: 'aep_source_retention',
};

/** Makes callback entry and acknowledgement failure explicit without timing sleeps. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Reads actual retained files independently of the originating writer object. */
async function retainedFiles(root: string): Promise<Buffer[]> {
  const buffers: Buffer[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) buffers.push(...(await retainedFiles(path)));
    else if (entry.isFile()) buffers.push(await readFile(path));
  }
  return buffers;
}

/** Reads the existing ordinary transcript contract; restricted chunks must stay outside it. */
async function ordinaryEvents(root: string): Promise<WorkerCanonicalEventRecord[]> {
  return (await readFile(join(root, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkerCanonicalEventRecord);
}

/** Reads one selected restricted source file and refuses torn JSONL. */
async function sourceRecords(root: string, sequence: number): Promise<unknown[]> {
  const source = await readFile(join(root, 'runtime', 'observations', `${sequence}.jsonl`), 'utf8');
  if (!source.endsWith('\n')) throw new Error('Restricted source has an incomplete final record.');
  return source
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

/** Builds the exact existing emission envelope from fixture-owned expected values. */
function observationEvent(
  sequence: number,
  observation: RuntimeObservation
): WorkerCanonicalEventRecord {
  return {
    kind: 'event',
    schemaVersion: 1,
    lineage,
    sequence,
    event: { type: 'observation.recorded', data: observation },
  };
}

describe('WorkerTranscriptWriter source retention', () => {
  it('retains the original ordinary event before delivery and after lost ACK, later writes and cancellation', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'worker-source-ordinary-'));
    const entered = deferred<{
      record: WorkerCanonicalEventRecord;
      events: WorkerCanonicalEventRecord[];
    }>();
    const release = deferred<void>();
    const lostAck = new Error('Synthetic Core durable acknowledgement lost.');
    const appendEvent = vi.fn(async (record: WorkerCanonicalEventRecord) => {
      entered.resolve({ record, events: await ordinaryEvents(sessionDir) });
      await release.promise;
      throw lostAck;
    });
    const writer = new WorkerTranscriptWriter({ lineage, sessionDir, appendEvent });
    const outcome = writer.writeAndAppendEvent({ type: 'worker.ready', data: { pid: 1540 } }).then(
      () => null,
      (error: unknown) => error
    );
    try {
      const observed = await entered.promise;
      const expected = {
        kind: 'event',
        schemaVersion: 1,
        lineage,
        sequence: 0,
        event: { type: 'worker.ready', data: { pid: 1540 } },
      };
      // SOURCE-RETENTION: exact record and sequence exist before exposure to Core.
      expect(observed.record).toEqual(expected);
      expect(observed.events).toEqual([expected]);
      await writer.writeAssistantMessage({ status: 'completed', text: 'later ordinary item' });
      release.resolve();
      expect(await outcome).toBe(lostAck);
      await expect(
        writer.writeAndAppendEvent({ type: 'worker.heartbeat', data: { status: 'running' } })
      ).rejects.toBe(lostAck);
      writer.stopLiveEvents(lostAck);
      await writer.writeTerminalOutcome({ status: 'failed', stopReason: 'error' });
      // A fresh filesystem read proves the source does not depend on the live queue.
      expect((await ordinaryEvents(sessionDir))[0]).toEqual(expected);
      expect(appendEvent).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await outcome;
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('retains distinct metadata emissions and every exact restricted chunk before lost ACK', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'worker-source-restricted-'));
    // Include a chunk boundary, a NUL and non-UTF-8 bytes; retained bytes must be exact.
    const body = Buffer.concat([Buffer.alloc(48 * 1024, 97), Buffer.from([0, 255, 195, 40, 10])]);
    const metadata: RuntimeObservation = {
      observationId: 'obs_retained_source',
      sourceRef: 'source_retained',
      sourceSequence: 0,
      observedAt: '2026-10-23T00:00:00.000Z',
      fact: {
        kind: 'native-transcript',
        runtimeOriginRef: null,
        coverage: 'collecting',
        native: {
          harness: 'pi',
          authoredVersion: '1.0.2',
          measuredVersion: null,
          imageDigest: null,
          format: 'application/octet-stream',
          preLaunchWatermark: 0,
          range: { start: 0, end: body.length },
          observedBytes: body.length,
          retainedBytes: body.length,
          omittedBytes: 0,
          sourceEnded: false,
        },
      },
      content: {
        state: 'expected',
        mediaType: 'application/octet-stream',
        boundary: 'native-content-v1',
        bytes: body.length,
        sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        chunkCount: 2,
      },
    };
    const entered = deferred<{ record: WorkerCanonicalEventRecord; source: unknown }>();
    const release = deferred<void>();
    const lostAck = new Error('Synthetic Core durable acknowledgement lost.');
    const delivered: WorkerCanonicalEventRecord[] = [];
    const writer = new WorkerTranscriptWriter({
      lineage,
      sessionDir,
      appendEvent: async (record) => {
        delivered.push(record);
        if (record.sequence === 1) {
          entered.resolve({
            record,
            source: await sourceRecords(sessionDir, 1).catch((error: unknown) => error),
          });
          await release.promise;
          throw lostAck;
        }
      },
    });
    await writer.writeObservation(metadata);
    await expect(sourceRecords(sessionDir, 0)).rejects.toMatchObject({ code: 'ENOENT' });
    const outcome = writer.writeObservation(metadata, body).then(
      () => null,
      (error: unknown) => error
    );
    try {
      const observed = await entered.promise;
      const chunks = [0, 1].map((chunkIndex) => ({
        kind: 'event',
        schemaVersion: 1,
        lineage,
        sequence: 2 + chunkIndex,
        event: {
          type: 'observation.content.chunk',
          data: {
            observationId: metadata.observationId,
            chunkIndex,
            byteOffset: chunkIndex * 48 * 1024,
            encoding: 'base64',
            data: body
              .subarray(chunkIndex * 48 * 1024, (chunkIndex + 1) * 48 * 1024)
              .toString('base64'),
          },
        },
      }));
      const expected = [observationEvent(0, metadata), observationEvent(1, metadata), ...chunks];
      // SOURCE-RETENTION and expected-before-content: one observation ID does not overwrite either emission.
      expect(observed.record).toEqual(expected[1]);
      expect(await ordinaryEvents(sessionDir)).toEqual(expected.slice(0, 2));
      // The selected source begins with its own metadata emission and preserves exact chunk order.
      expect(observed.source).toEqual(expected.slice(1));
      release.resolve();
      expect(await outcome).toBe(lostAck);
      await expect(
        writer.writeAndAppendEvent({ type: 'worker.heartbeat', data: { status: 'running' } })
      ).rejects.toBe(lostAck);
      writer.stopLiveEvents(lostAck);
      await writer.writeTerminalOutcome({ status: 'failed', stopReason: 'error' });
      expect(await sourceRecords(sessionDir, 1)).toEqual(expected.slice(1));
      const ordinary = await ordinaryEvents(sessionDir);
      expect(ordinary.some((record) => record.event.type === 'observation.content.chunk')).toBe(
        false
      );
      // The failed metadata ACK prevents chunk exposure, but must not discard owed source bytes.
      expect(delivered.map((record) => record.sequence)).toEqual([0, 1]);
    } finally {
      release.resolve();
      await outcome;
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('keeps privacy-refused bytes out of retained source through the real admission and writer seam', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'worker-source-refused-'));
    const marker = 'synthetic-private-value-r1540';
    const body = Buffer.from(`Result contains ${marker}.`);
    const delivered: WorkerCanonicalEventRecord[] = [];
    const writer = new WorkerTranscriptWriter({
      lineage,
      sessionDir,
      appendEvent: async (record) => {
        delivered.push(record);
      },
    });
    try {
      await emitRuntimeFact(
        {
          packageSnapshotId: lineage.packageSnapshotId,
          captureCoverage: { scope: 'server', value: 'on' },
          credentialValues: [marker],
          emit: (record, bytes) => writer.writeObservation(record, bytes),
        },
        { sourceRef: 'privacy_source', sourceSequence: 0 },
        {
          kind: 'assistant',
          runtimeOriginRef: null,
          messageRef: 'privacy_message',
          phase: 'completed',
          representation: 'snapshot',
        },
        { bytes: body, mediaType: 'text/plain', boundary: 'runtime.assistant.text' }
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.event).toMatchObject({
        type: 'observation.recorded',
        data: { content: { state: 'unavailable', reason: 'credential-excluded' } },
      });
      for (const bytes of await retainedFiles(sessionDir)) {
        // SOURCE-RETENTION cannot admit a body that the capture owner refused.
        expect(bytes.includes(Buffer.from(marker))).toBe(false);
        expect(bytes.includes(Buffer.from(body.toString('base64')))).toBe(false);
      }
      expect((await ordinaryEvents(sessionDir))[0]).toEqual(delivered[0]);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});
