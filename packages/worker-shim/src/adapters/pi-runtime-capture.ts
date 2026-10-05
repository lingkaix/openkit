import {
  type RuntimeCaptureInput,
  type RuntimeFact,
  RuntimeSemanticCapture,
  runtimeRef,
  runtimeToolName,
} from '../runtime-capture.js';
import type { PiTurnProjection } from './pi.js';

/** Pi's completed SDK events mapped into the existing structural and restricted-content collector. */
export class PiRuntimeCapture {
  private readonly semantic: RuntimeSemanticCapture;
  private readonly sourceRef: string;
  private queue: Promise<void> = Promise.resolve();
  private abandoned = false;
  private assistantCount = 0;

  /** Keeps capture admission immutable; abandonment suppresses subsequent calls, not an entered sink effect. */
  public constructor(
    private readonly input: RuntimeCaptureInput,
    private readonly turnId: string
  ) {
    this.sourceRef = runtimeRef('rts', input.packageSnapshotId, `pi-channel:${turnId}`);
    this.semantic = new RuntimeSemanticCapture({
      ...input,
      emit: (record, body) => (this.abandoned ? Promise.resolve() : input.emit(record, body)),
    });
  }

  /** Starts structural collection before prompt admission even when restricted bodies are off. */
  public start(): Promise<void> {
    return this.enqueue(async () => {
      await this.emit({
        kind: 'coverage',
        runtimeOriginRef: null,
        family: 'primary-content',
        coverage: this.input.captureCoverage.value === 'on' ? 'collecting' : 'off',
      });
      await this.emit({
        kind: 'coverage',
        runtimeOriginRef: null,
        family: 'child-metadata',
        coverage: 'unsupported',
      });
      await this.emit({
        kind: 'coverage',
        runtimeOriginRef: null,
        family: 'child-content',
        coverage: 'unsupported',
      });
      // The private channel proves activity of this primary host, but supplies no native child identity.
      await this.emit({ kind: 'origin', runtimeOriginRef: null, phase: 'started' });
    });
  }

  /** Consumes only positively selected outward assistant and native tool events; reasoning is excluded. */
  public observe(value: unknown): void {
    void this.enqueue(async () => {
      if (!isRecord(value) || typeof value.type !== 'string') {
        await this.gap('malformed-frame');
        return;
      }
      if (
        value.type === 'message_end' &&
        isRecord(value.message) &&
        value.message.role === 'assistant'
      ) {
        const message = value.message;
        const index = this.assistantCount++;
        if (!Array.isArray(message.content)) {
          await this.gap('malformed-frame');
          return;
        }
        const texts: string[] = [];
        for (const part of message.content) {
          if (!isRecord(part)) {
            await this.gap('malformed-frame');
            continue;
          }
          if (part.type === 'text') {
            if (typeof part.text !== 'string') {
              await this.gap('malformed-frame');
              continue;
            }
            texts.push(part.text);
          }
        }
        await this.assistant(
          texts.join(''),
          index,
          message.stopReason === 'aborted'
            ? 'interrupted'
            : message.stopReason === 'error'
              ? 'failed'
              : 'completed'
        );
      } else if (value.type === 'tool_execution_start' || value.type === 'tool_execution_end') {
        if (typeof value.toolCallId !== 'string') {
          await this.gap('malformed-frame');
          return;
        }
        const starting = value.type === 'tool_execution_start';
        const fact: RuntimeFact = {
          kind: 'tool',
          runtimeOriginRef: null,
          callRef: runtimeRef(
            'rtc',
            this.input.packageSnapshotId,
            `${this.turnId}:${value.toolCallId}`
          ),
          phase: starting ? 'started' : value.isError === true ? 'failed' : 'completed',
          ...(runtimeToolName(value.toolName) ? { toolName: runtimeToolName(value.toolName) } : {}),
        };
        const body = starting ? value.args : value.result;
        await this.semantic.emit(
          this.sourceRef,
          fact,
          body === undefined
            ? undefined
            : {
                bytes: Buffer.from(JSON.stringify(body)),
                mediaType: 'application/json',
                boundary: starting ? 'runtime.tool.arguments' : 'runtime.tool.result',
              }
        );
      }
      await this.semantic.flushCompleted();
    }).catch(() => undefined);
  }

  /** Records a native omitted frame as an explicit collection gap. */
  public omitted(): void {
    void this.enqueue(() => this.gap('limit-exceeded')).catch(() => undefined);
  }

  /** Joins observed events and the validated original terminal text, independent of the trimmed public result. */
  public finalize(status: PiTurnProjection['status'], assistantText: string | null): Promise<void> {
    return this.enqueue(async () => {
      if (assistantText !== null && this.assistantCount === 0)
        await this.assistant(assistantText, 0, status);
      await this.emit({ kind: 'origin', runtimeOriginRef: null, phase: status });
      await this.semantic.flushCompleted();
      await this.semantic.interrupt();
      await this.emit({
        kind: 'coverage',
        runtimeOriginRef: null,
        family: 'primary-content',
        coverage: 'ended',
      });
    });
  }

  /** Preserves accepted records and prevents later collector calls after a lifecycle deadline expires. */
  public abandon(): void {
    this.abandoned = true;
  }

  /** Serializes facts at the existing source-order boundary and retains a failed publication as failure. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(() => (this.abandoned ? undefined : work()));
    this.queue.catch(() => undefined);
    return this.queue;
  }

  /** Emits an outward assistant snapshot under the existing semantic-unit credential and content gate. */
  private assistant(text: string, index: number, phase: RuntimeFact['phase']): Promise<void> {
    return this.semantic.emit(
      this.sourceRef,
      {
        kind: 'assistant',
        runtimeOriginRef: null,
        messageRef: runtimeRef('rtm', this.input.packageSnapshotId, `${this.turnId}:${index}`),
        phase,
        representation: 'snapshot',
      },
      { bytes: Buffer.from(text), mediaType: 'text/plain', boundary: 'runtime.assistant.text' }
    );
  }

  /** Uses the existing metadata vocabulary rather than retaining native envelopes. */
  private emit(fact: RuntimeFact): Promise<void> {
    return this.semantic.emit(this.sourceRef, fact);
  }

  /** Missing or oversized outward frames stay explicit gaps and never become complete-looking prefixes. */
  private gap(reason: 'malformed-frame' | 'limit-exceeded'): Promise<void> {
    return this.emit({
      kind: 'coverage',
      runtimeOriginRef: null,
      family: 'primary-content',
      coverage: 'unavailable',
      reason,
    });
  }
}

/** Narrows native event fields without importing the host or SDK into the shim. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
