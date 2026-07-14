import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type WorkerCanonicalEventRecord,
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
  type: string;
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
export interface WorkerTerminalOutcomeInput {
  /** Terminal outcome status. */
  status: 'completed' | 'failed' | 'interrupted' | 'cancelled';
  /** Optional product-safe diagnostic summary for terminal failures. */
  diagnostics?: Record<string, string>;
  /** Optional product-safe terminal reason. */
  reason?: string;
}

/**
 * Worker transcript writer options.
 */
export interface WorkerTranscriptWriterOptions {
  /** Durable session directory, usually `/openkit/session`. */
  sessionDir: string;
  /** Lineage fields attached to every record. */
  lineage: WorkerLineage;
}

/**
 * Durable transcript writer for sandbox-local worker shims.
 */
export class WorkerTranscriptWriter {
  private readonly lineage: WorkerLineage;
  private readonly sessionDir: string;
  private sequence = 0;

  /**
   * Creates a writer for one worker session.
   *
   * @param options Session directory and lineage.
   */
  public constructor(options: WorkerTranscriptWriterOptions) {
    this.lineage = options.lineage;
    this.sessionDir = options.sessionDir;
  }

  /**
   * Writes one worker event record.
   *
   * @param input Worker event.
   * @returns Promise that resolves after the line is durable.
   */
  public async writeEvent(input: WorkerEventInput): Promise<void> {
    const record = WorkerTranscriptEventRecordSchema.parse({
      ...this.nextBaseRecord('event'),
      event: {
        data: input.data ?? {},
        type: input.type,
      },
    });
    await this.appendJsonl('events.jsonl', record);
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
    const eventType = input.status === 'completed' ? 'turn.completed' : 'turn.failed';
    const record = WorkerTranscriptEventRecordSchema.parse({
      ...this.nextBaseRecord('event'),
      event: {
        data: {
          ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          status: input.status,
        },
        type: eventType,
      },
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
  private async appendJsonl(fileName: string, record: Record<string, unknown>): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await appendFile(join(this.sessionDir, fileName), `${JSON.stringify(record)}\n`, 'utf8');
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
