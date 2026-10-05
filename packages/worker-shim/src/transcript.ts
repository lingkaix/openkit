import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildWorkerCanonicalTerminalEventRecord,
  type WorkerCanonicalEventRecord,
  type WorkerCanonicalNonTerminalEventType,
  type WorkerCanonicalTerminalEventDataInput,
  type WorkerLineage,
  type WorkerTextPart,
  WorkerTranscriptArtifactRecordSchema,
  WorkerTranscriptEventRecordSchema,
  WorkerTranscriptItemRecordSchema,
} from '@openkit/worker-protocol';

import {
  RUNTIME_CONTENT_CHUNK_BYTES,
  type RuntimeObservation,
  runtimeDigest,
} from './runtime-capture.js';

import { containTurnLifecycleRecorder, type TurnLifecycleRecorder } from './turn-timeline.js';

export type { WorkerLineage, WorkerTextPart } from '@openkit/worker-protocol';

/**
 * Worker event candidate written to `events.jsonl`.
 */
export interface WorkerEventInput {
  /** Stable event type. */
  type: WorkerCanonicalNonTerminalEventType;
  /** Product-safe event payload. */
  data?: Record<string, unknown>;
}

/**
 * Assistant-message candidate written to `items.jsonl`.
 */
export interface WorkerAssistantMessageInput {
  /** Message status. */
  status: 'in_progress' | 'completed' | 'failed';
  /** Optional plain text content. */
  text?: string;
  /** Optional structured text parts. */
  parts?: WorkerTextPart[];
}

/**
 * Artifact candidate written to `artifacts.jsonl`.
 */
export interface WorkerArtifactInput {
  /** Artifact kind consumed by NanoCore import. */
  kind: 'report' | 'diff' | 'file' | 'summary';
  /** User-facing artifact title. */
  title: string;
  /** Worker-visible artifact path. */
  path: string;
  /** Exact text-compatible media type consumed by NanoCore import. */
  mediaType: 'text/markdown' | 'text/plain' | 'application/json';
  /** Optional immutable Material target and base proposed by this Artifact. */
  materialProposal?: {
    /** Target Material id. */
    materialId: string;
    /** Immutable base Material revision id. */
    baseRevisionId: string;
    /** Lowercase SHA-256 digest of the exact base revision content. */
    baseContentDigest: string;
  };
}

/**
 * Worker terminal outcome written to `events.jsonl`.
 */
export type WorkerTerminalOutcomeInput = WorkerCanonicalTerminalEventDataInput;

/**
 * Worker transcript writer options.
 */
export interface WorkerTranscriptWriterOptions {
  /** Shared Turn recorder for queue counts and observed live-delivery waits. */
  recordLifecycleFact?: TurnLifecycleRecorder;
  /** Durable session directory, usually `/openkit/session`. */
  sessionDir: string;
  /** Lineage fields attached to every record. */
  lineage: WorkerLineage;
  /** Optional live acceptance callback serialized with each non-terminal transcript event. */
  appendEvent?: ((record: WorkerCanonicalEventRecord) => Promise<void>) | undefined;
}

/**
 * Durable transcript writer for sandbox-local worker shims.
 */
export class WorkerTranscriptWriter {
  private appendQueue: Promise<void> = Promise.resolve();
  private liveQueue: Promise<void> = Promise.resolve();
  private readonly appendEvent: ((record: WorkerCanonicalEventRecord) => Promise<void>) | null;
  private eventsSealed = false;
  private readonly lineage: WorkerLineage;
  private readonly sessionDir: string;
  private sequence = 0;
  private readonly recordLifecycleFact: TurnLifecycleRecorder | undefined;

  /**
   * Creates a writer for one worker session.
   *
   * @param options Session directory and lineage.
   */
  public constructor(options: WorkerTranscriptWriterOptions) {
    this.appendEvent = options.appendEvent ?? null;
    this.recordLifecycleFact = containTurnLifecycleRecorder(options.recordLifecycleFact);
    this.lineage = options.lineage;
    this.sessionDir = options.sessionDir;
  }

  /**
   * Reports whether terminal outcome writing has sealed the event transcript.
   *
   * @returns True after terminal outcome writing starts.
   */
  public get eventTranscriptSealed(): boolean {
    return this.eventsSealed;
  }

  /**
   * Writes one worker event record and waits for configured live acceptance.
   *
   * @param input Worker event.
   * @returns Durable canonical event record after the line is written.
   * @throws Error when terminal outcome writing has sealed the event transcript.
   */
  public async writeAndAppendEvent(input: WorkerEventInput): Promise<WorkerCanonicalEventRecord> {
    if (this.eventsSealed) {
      throw new Error('Worker transcript events are sealed after the terminal outcome.');
    }
    const record = WorkerTranscriptEventRecordSchema.parse({
      ...this.nextBaseRecord('event'),
      event: {
        data: input.data ?? {},
        type: input.type,
      },
    });
    const appended = this.appendJsonl('events.jsonl', record);
    await this.enqueueLive(async () => {
      await appended;
      await this.appendEvent?.(record);
    });
    return record;
  }

  /** Publishes metadata first, then restricted chunks without writing chunk bytes to the ordinary transcript. */
  public async writeObservation(input: RuntimeObservation, body?: Uint8Array): Promise<void> {
    if (this.eventsSealed || !this.appendEvent) {
      throw new Error('Runtime observations require unsealed live worker control.');
    }
    if (input.content.state === 'expected' && body !== undefined) {
      if (
        body.byteLength !== input.content.bytes ||
        runtimeDigest(body) !== input.content.sha256 ||
        input.content.chunkCount !== Math.ceil(body.byteLength / RUNTIME_CONTENT_CHUNK_BYTES)
      ) {
        throw new Error('Runtime observation body does not match its descriptor.');
      }
    } else if (input.content.state !== 'expected' && body !== undefined) {
      throw new Error('Runtime observation body was not admitted.');
    }
    const record = WorkerTranscriptEventRecordSchema.parse({
      ...this.nextBaseRecord('event'),
      event: { type: 'observation.recorded', data: input },
    });
    const chunkCount =
      input.content.state === 'expected' && body !== undefined ? input.content.chunkCount : 0;
    const firstChunkSequence = this.sequence;
    this.sequence += chunkCount;
    const appended = this.appendJsonl('events.jsonl', record);
    await this.enqueueLive(async () => {
      await appended;
      await this.appendEvent?.(record);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const byteOffset = chunkIndex * RUNTIME_CONTENT_CHUNK_BYTES;
        const chunk = WorkerTranscriptEventRecordSchema.parse({
          kind: 'event',
          lineage: this.lineage,
          schemaVersion: 1,
          sequence: firstChunkSequence + chunkIndex,
          event: {
            type: 'observation.content.chunk',
            data: {
              observationId: input.observationId,
              chunkIndex,
              byteOffset,
              encoding: 'base64',
              data: Buffer.from(
                body!.subarray(byteOffset, byteOffset + RUNTIME_CONTENT_CHUNK_BYTES)
              ).toString('base64'),
            },
          },
        });
        await this.appendEvent?.(chunk);
      }
    });
  }

  /** Serializes live acceptance as well as local append, including concurrent child sources and heartbeats. */
  private enqueueLive(operation: () => Promise<void>): Promise<void> {
    const enqueuedAt = performance.now();
    this.recordLifecycleFact?.({ label: 'transcript_enqueue' });
    this.liveQueue = this.liveQueue.then(operation);
    // Observe rejection without recovering the delivery queue or changing its barrier.
    void this.liveQueue.then(
      () =>
        this.recordLifecycleFact?.({
          label: 'transcript_delivered',
          durationMs: performance.now() - enqueuedAt,
        }),
      () =>
        this.recordLifecycleFact?.({
          label: 'transcript_failed',
          durationMs: performance.now() - enqueuedAt,
        })
    );
    return this.liveQueue;
  }

  /**
   * Waits for all already-queued live event acknowledgements; terminal sealing prevents later events from extending this barrier.
   *
   * @returns Promise that resolves only after every queued event has live acceptance.
   * @throws The deciding live-delivery error when an event was rejected.
   */
  public async drainLiveEvents(): Promise<void> {
    await this.liveQueue;
  }

  /**
   * Writes one assistant-message item candidate.
   *
   * @param input Assistant-message item candidate.
   * @returns Promise that resolves after the line is durable.
   */
  public async writeAssistantMessage(input: WorkerAssistantMessageInput): Promise<void> {
    const record = WorkerTranscriptItemRecordSchema.parse({
      ...this.nextBaseRecord('item'),
      item: {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.parts === undefined ? {} : { parts: input.parts }),
        status: input.status,
        type: 'assistant-message',
      },
    });
    await this.appendJsonl('items.jsonl', record);
  }

  /**
   * Writes one artifact candidate.
   *
   * @param input Artifact candidate.
   * @returns Promise that resolves after the line is durable.
   */
  public async writeArtifact(input: WorkerArtifactInput): Promise<void> {
    const record = WorkerTranscriptArtifactRecordSchema.parse({
      ...this.nextBaseRecord('artifact'),
      artifact: {
        kind: input.kind,
        materialProposal: input.materialProposal,
        mediaType: input.mediaType,
        path: input.path,
        title: input.title,
      },
    });
    await this.appendJsonl('artifacts.jsonl', record);
  }

  /**
   * Writes a terminal worker outcome event.
   *
   * @param input Terminal outcome.
   * @returns Durable canonical terminal event record.
   */
  public async writeTerminalOutcome(
    input: WorkerTerminalOutcomeInput
  ): Promise<WorkerCanonicalEventRecord> {
    this.eventsSealed = true;
    const sequence = this.sequence;
    this.sequence += 1;
    const record = buildWorkerCanonicalTerminalEventRecord({
      data: input,
      lineage: this.lineage,
      sequence,
    });
    await this.appendJsonl('events.jsonl', record);
    return record;
  }

  /**
   * Appends a JSONL record to the session directory.
   *
   * @param fileName Session file name.
   * @param record Serializable record.
   * @returns Promise that resolves after the record is appended.
   */
  private appendJsonl(fileName: string, record: Record<string, unknown>): Promise<void> {
    this.appendQueue = this.appendQueue.then(async () => {
      await mkdir(this.sessionDir, { recursive: true });
      await appendFile(join(this.sessionDir, fileName), `${JSON.stringify(record)}\n`, 'utf8');
    });
    return this.appendQueue;
  }

  /**
   * Builds the shared record envelope and increments the writer sequence.
   *
   * @param kind Worker transcript record kind.
   * @returns Shared record fields.
   */
  private nextBaseRecord(kind: 'event' | 'item' | 'artifact'): Record<string, unknown> {
    const record = {
      kind,
      lineage: this.lineage,
      schemaVersion: 1,
      sequence: this.sequence,
    };

    this.sequence += 1;

    return record;
  }
}
