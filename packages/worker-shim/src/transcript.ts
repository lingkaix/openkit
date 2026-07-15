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
  /** Optional media type. */
  mediaType?: string | null;
}

/**
 * Worker terminal outcome written to `events.jsonl`.
 */
export type WorkerTerminalOutcomeInput = WorkerCanonicalTerminalEventDataInput;

/**
 * Worker transcript writer options.
 */
export interface WorkerTranscriptWriterOptions {
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
  private readonly appendEvent: ((record: WorkerCanonicalEventRecord) => Promise<void>) | null;
  private eventsSealed = false;
  private readonly lineage: WorkerLineage;
  private readonly sessionDir: string;
  private sequence = 0;

  /**
   * Creates a writer for one worker session.
   *
   * @param options Session directory and lineage.
   */
  public constructor(options: WorkerTranscriptWriterOptions) {
    this.appendEvent = options.appendEvent ?? null;
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
    const appendEvent = this.appendEvent;
    await this.appendJsonl(
      'events.jsonl',
      record,
      appendEvent ? () => appendEvent(record) : undefined
    );
    return record;
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
        mediaType: input.mediaType ?? null,
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
   * @param afterAppend Optional effect serialized after the durable file append.
   * @returns Promise that resolves after the record is appended.
   */
  private appendJsonl(
    fileName: string,
    record: Record<string, unknown>,
    afterAppend?: (() => Promise<void>) | undefined
  ): Promise<void> {
    this.appendQueue = this.appendQueue.then(async () => {
      await mkdir(this.sessionDir, { recursive: true });
      await appendFile(join(this.sessionDir, fileName), `${JSON.stringify(record)}\n`, 'utf8');
      await afterAppend?.();
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
