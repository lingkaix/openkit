import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  buildWorkerCanonicalTerminalEventRecord,
  WORKER_CONTROL_EVENT_APPEND_MAX_BYTES,
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordEmissionSchema,
  type WorkerCanonicalNonTerminalEventType,
  type WorkerCanonicalTerminalEventDataInput,
  type WorkerLineage,
  WorkerObservationDataSchema,
  type WorkerTextPart,
  WorkerTranscriptItemRecordEmissionSchema,
  workerObservationSourceRelativePath,
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
 * Worker terminal outcome written to `events.jsonl`.
 */
export type WorkerTerminalOutcomeInput = WorkerCanonicalTerminalEventDataInput;

/**
 * Worker transcript writer options.
 */
export interface WorkerTranscriptWriterOptions {
  /** Shared Turn recorder for queue counts and observed live-delivery waits. */
  recordLifecycleFact?: TurnLifecycleRecorder;
  /** Caller-supplied output directory; production uses the exact admitted Turn capture. */
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
  private observationDeliveryStopped = false;
  private liveStopReason: Error | null = null;
  private liveIncomplete = false;
  private readonly lineage: WorkerLineage;
  private readonly sessionDir: string;
  private readonly createdFiles = new Set<string>();
  /** An expected body may wait for the semantic unit's credential check after its metadata ACK. */
  private readonly deferredObservations = new Map<string, WorkerCanonicalEventRecord>();
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
   * Reports whether cancellation or terminal writing has sealed ordinary event admission.
   *
   * @returns True after ordinary event admission ends.
   */
  public get eventTranscriptSealed(): boolean {
    return this.eventsSealed;
  }

  /** Whether live output was refused or suppressed; local bytes never establish remote acceptance. */
  public get liveEventsIncomplete(): boolean {
    return this.liveIncomplete;
  }

  /** Seals ordinary admission and prevents new live effects while retaining an entered effect's actual result. */
  public stopLiveEvents(reason: Error): void {
    this.eventsSealed = true;
    this.liveStopReason ??= reason;
    this.deferredObservations.clear();
  }

  /** Stops dispatch of further live observations and chunks without cancelling an entered append. */
  public stopObservationDelivery(): void {
    this.observationDeliveryStopped = true;
    this.liveIncomplete = true;
    this.deferredObservations.clear();
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
      this.requireLiveAdmission();
      throw new Error('Worker transcript events are sealed after the terminal outcome.');
    }
    const record = WorkerCanonicalEventRecordEmissionSchema.parse({
      ...this.nextBaseRecord('event'),
      event: {
        data: input.data ?? {},
        type: input.type,
      },
    });
    const appended = this.appendJsonl('events.jsonl', record);
    await this.enqueueLive(appended, async () => {
      await this.appendLive(record);
      return true;
    });
    return record;
  }

  /** Publishes metadata first, then restricted chunks without writing chunk bytes to the ordinary transcript. */
  public async writeObservation(input: RuntimeObservation, body?: Uint8Array): Promise<void> {
    if (this.eventsSealed || !this.appendEvent) {
      this.requireLiveAdmission();
      throw new Error('Runtime observations require unsealed live worker control.');
    }
    if (this.observationDeliveryStopped) return;
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
    const original = this.deferredObservations.get(input.observationId);
    if (
      original &&
      (body === undefined ||
        original.event.type !== 'observation.recorded' ||
        !isDeepStrictEqual(original.event.data, WorkerObservationDataSchema.parse(input)))
    )
      throw new Error('Deferred Worker body does not match its original observation.');
    if (original) this.deferredObservations.delete(input.observationId);
    const record =
      original ??
      WorkerCanonicalEventRecordEmissionSchema.parse({
        ...this.nextBaseRecord('event'),
        event: { type: 'observation.recorded', data: input },
      });
    if (input.content.state === 'expected' && body === undefined)
      this.deferredObservations.set(input.observationId, record);
    if (input.content.state === 'unavailable' && input.content.expectedObservationId)
      this.deferredObservations.delete(input.content.expectedObservationId);
    const chunkCount =
      input.content.state === 'expected' && body !== undefined ? input.content.chunkCount : 0;
    const firstChunkSequence = this.sequence;
    this.sequence += chunkCount;
    // Freeze the exact admitted envelopes before any await can change caller-owned bytes.
    const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => {
      const byteOffset = chunkIndex * RUNTIME_CONTENT_CHUNK_BYTES;
      return WorkerCanonicalEventRecordEmissionSchema.parse({
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
    });
    // Reserve the local position now. Decide metadata admission at its live queue's turn,
    // before either transcript can retain it. Once admitted, the same owner joins its append.
    const predecessor = this.liveQueue;
    let admitted = false;
    const admit = async () => {
      // Local I/O still settles if earlier live delivery failed.
      await predecessor.catch(() => undefined);
      admitted = !this.observationDeliveryStopped;
      return admitted;
    };
    if (original && chunks.length === 0) {
      await predecessor;
      return;
    }
    const metadata = original ? this.appendQueue : this.appendJsonl('events.jsonl', record, admit);
    // Wait for the original declaration ACK before writing restricted source bytes.
    let decideDeclaration: (admitted: boolean) => void = () => {};
    const declaration = new Promise<boolean>((resolve) => {
      decideDeclaration = resolve;
    });
    const source =
      body === undefined
        ? undefined
        : this.appendJsonl(
            workerObservationSourceRelativePath(record.sequence),
            [record, ...chunks],
            () => declaration
          );
    void source?.catch(() => undefined);
    try {
      await this.enqueueLive(metadata, async () => {
        if ((!original && !admitted) || this.observationDeliveryStopped) return false;
        if (!original) await this.appendLive(record);
        decideDeclaration(!this.observationDeliveryStopped);
        await source;
        for (const chunk of chunks) {
          if (this.observationDeliveryStopped) return false;
          await this.appendLive(chunk);
        }
        return !this.observationDeliveryStopped;
      });
    } finally {
      decideDeclaration(false);
    }
  }

  /** Checks cancellation at each effect boundary, including between restricted content chunks. */
  private async appendLive(record: WorkerCanonicalEventRecord): Promise<void> {
    this.requireLiveAdmission();
    await this.appendEvent?.(record);
  }

  /** Retains the caller-owned suppression identity without treating an unpublished record as accepted. */
  private requireLiveAdmission(): void {
    if (!this.liveStopReason) return;
    this.liveIncomplete = true;
    throw this.liveStopReason;
  }

  /** Joins local append settlement before reporting delivery, suppression, or the original failure. */
  private enqueueLive(appended: Promise<void>, operation: () => Promise<boolean>): Promise<void> {
    const enqueuedAt = performance.now();
    let delivered = true;
    this.recordLifecycleFact?.({ label: 'transcript_enqueue' });
    // Observe both promises immediately. An earlier live rejection must not skip the
    // local append's settlement, leave its rejection unhandled, or replace the first failure.
    this.liveQueue = Promise.allSettled([this.liveQueue, appended]).then(async ([live, local]) => {
      if (live.status === 'rejected') throw live.reason;
      if (local.status === 'rejected') throw local.reason;
      delivered = await operation();
    });
    // Observe rejection without recovering the delivery queue or changing its barrier.
    void this.liveQueue.then(
      () =>
        this.recordLifecycleFact?.({
          label: delivered ? 'transcript_delivered' : 'transcript_failed',
          durationMs: performance.now() - enqueuedAt,
        }),
      () => {
        this.liveIncomplete = true;
        this.recordLifecycleFact?.({
          label: 'transcript_failed',
          durationMs: performance.now() - enqueuedAt,
        });
      }
    );
    return this.liveQueue;
  }

  /**
   * Joins admitted live event acknowledgements. Terminal sealing prevents later events from extending this barrier.
   *
   * @returns Resolves after entered appends settle and queued capture suppression, if any, finishes.
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
    const record = WorkerTranscriptItemRecordEmissionSchema.parse({
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
   * Writes a terminal worker outcome event.
   *
   * @param input Terminal outcome.
   * @returns Durable canonical terminal event record.
   */
  public async writeTerminalOutcome(
    input: WorkerTerminalOutcomeInput
  ): Promise<WorkerCanonicalEventRecord> {
    this.eventsSealed = true;
    this.deferredObservations.clear();
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
   * @param records Serializable record or restricted source records.
   * @param admit Optional capture admission checked at the reserved queue position.
   * @returns Promise that resolves after the append or its suppression.
   */
  private appendJsonl(
    fileName: string,
    records: Record<string, unknown> | Record<string, unknown>[],
    admit?: () => boolean | Promise<boolean>
  ): Promise<void> {
    this.appendQueue = this.appendQueue.then(async () => {
      if (admit && !(await admit())) return;
      const path = join(this.sessionDir, fileName);
      const restricted = Array.isArray(records);
      const lines = (restricted ? records : [records]).map(
        (record) => `${JSON.stringify(record)}\n`
      );
      if (
        restricted &&
        lines.some((line) => Buffer.byteLength(line) > WORKER_CONTROL_EVENT_APPEND_MAX_BYTES)
      ) {
        throw new Error('Worker observation source exceeds the existing event transport bound.');
      }
      const created = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (restricted) {
        await writeFile(path, lines.join(''), { flag: 'wx', mode: 0o600, flush: true });
      } else {
        await appendFile(path, lines[0]!, { encoding: 'utf8', mode: 0o600, flush: true });
      }
      if (restricted || !this.createdFiles.has(fileName)) {
        // Only changed entries need sync; mkdir identifies the newly created ancestor suffix.
        let directory = dirname(path);
        const last = created ? dirname(created) : directory;
        for (;;) {
          const handle = await open(directory, 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          if (directory === last) break;
          directory = dirname(directory);
        }
        if (!restricted) this.createdFiles.add(fileName);
      }
    });
    return this.appendQueue;
  }

  /**
   * Builds the shared record envelope and increments the writer sequence.
   *
   * @param kind Worker transcript record kind.
   * @returns Shared record fields.
   */
  private nextBaseRecord(kind: 'event' | 'item'): Record<string, unknown> {
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
