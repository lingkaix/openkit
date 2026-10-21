import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  NativeRuntimeCapture,
  RUNTIME_FRAME_MAX_BYTES,
  type RuntimeCaptureInput,
  type RuntimeFact,
  RuntimeSemanticCapture,
  runtimeRef,
  runtimeToolName,
} from '../runtime-capture.js';
import type { PiTurnProjection } from './pi.js';

/** Bounds waiting closures even when native events contain very little content. */
const CAPTURE_PENDING_EVENTS = 256;

/** Pi's completed SDK events mapped into the existing structural and restricted-content collector. */
export class PiRuntimeCapture {
  private readonly semantic: RuntimeSemanticCapture;
  private readonly native: NativeRuntimeCapture;
  private file:
    | { path: string; position: number; watermark: number; dev?: number; ino?: number }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly sourceRef: string;
  private queue: Promise<void> = Promise.resolve();
  private pending: Array<{ work: () => Promise<void>; bytes: number }> = [];
  private pendingBytes = 0;
  private draining = false;
  private limited = false;
  private abandoned = false;
  private finished = false;
  private assistantCount = 0;

  /** Keeps capture admission immutable; abandonment suppresses subsequent calls, not an entered sink effect. */
  public constructor(
    private readonly input: RuntimeCaptureInput,
    private readonly turnId: string
  ) {
    this.native = new NativeRuntimeCapture({
      ...input,
      emit: (record, body) => (this.abandoned ? Promise.resolve() : input.emit(record, body)),
    });
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

  /** Copies the native unit before the private-channel owner parses its payload. */
  public collectNative(bytes: Uint8Array): Promise<void> {
    if (this.abandoned) return Promise.resolve();
    const collection = this.native.write(`${this.sourceRef}:sdk`, bytes, {
      harness: 'pi',
      format: 'pi-sdk-event-json',
      runtimeOriginRef: null,
    });
    // A malformed control envelope may never reach observe; finish retains this rejection.
    void collection.catch(() => undefined);
    return collection;
  }

  /** Derives structural facts only after the original native unit has entered raw collection. */
  public observe(value: unknown, nativeBytes?: Uint8Array, nativeCollection?: Promise<void>): void {
    if (this.abandoned || this.limited) return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    } catch {
      this.admit(() => this.gap('malformed-frame'), 0);
      return;
    }
    const original = nativeCollection
      ? undefined
      : nativeBytes
        ? Buffer.from(nativeBytes)
        : Buffer.from(JSON.stringify(value) ?? '');
    this.admit(async () => {
      await (nativeCollection ?? this.collectNative(original!));
      await this.pollFile();
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
    }, bytes);
  }

  /** Records a native omitted frame as an explicit collection gap. */
  public omitted(): void {
    this.admit(() => this.gap('limit-exceeded'), 0);
  }

  /** Joins observed events and the validated original terminal text, independent of the trimmed public result. */
  public finalize(status: PiTurnProjection['status'], assistantText: string | null): Promise<void> {
    this.finished = true;
    clearTimeout(this.timer);
    return this.enqueue(async () => {
      await this.pollFile();
      await this.native.finish();
      // Capture phases keep their existing closed vocabulary; length is a non-success terminal result.
      const phase = status === 'length' ? 'failed' : status;
      if (assistantText !== null && this.assistantCount === 0)
        await this.assistant(assistantText, 0, phase);
      await this.emit({ kind: 'origin', runtimeOriginRef: null, phase });
      await this.semantic.flushCompleted();
      await this.semantic.interrupt();
      await this.emit({
        kind: 'coverage',
        runtimeOriginRef: null,
        family: 'primary-content',
        coverage: 'ended',
      });
      // The adapter already records rejected finalization as incomplete without changing native settlement.
      if (this.limited) throw new Error('Pi runtime capture backlog exceeded its limit.');
    });
  }

  /** Preserves accepted records and prevents later collector calls after a lifecycle deadline expires. */
  public abandon(): void {
    clearTimeout(this.timer);
    this.native.abandon();
    this.abandoned = true;
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Binds only the adapter-proved native file; a fresh allocation uses its known zero watermark. */
  public async bindFile(path: string, watermark?: number): Promise<void> {
    if (this.file) {
      if (this.file.path !== path) throw new Error('Pi native source changed.');
      return;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Pi native source is not a file.');
      this.file = {
        path,
        position: watermark ?? stat.size,
        watermark: watermark ?? stat.size,
        dev: stat.dev,
        ino: stat.ino,
      };
    } finally {
      await handle.close();
    }
    this.schedule();
  }
  /** Polls an already proved source without asking the native runtime to do more work. */
  private schedule(): void {
    if (this.abandoned || this.finished || !this.file) return;
    this.timer = setTimeout(() => {
      void this.enqueue(() => this.pollFile()).then(
        () => this.schedule(),
        () => undefined
      );
    }, 100);
    this.timer.unref();
  }
  /** Retains file bytes before any structural interpretation and refuses replacement or shrink. */
  private async pollFile(): Promise<void> {
    const file = this.file;
    if (!file || this.abandoned) return;
    const handle = await open(
      file.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.dev !== file.dev ||
        stat.ino !== file.ino ||
        stat.size < file.position
      )
        throw new Error('Pi native source changed.');
      const buffer = Buffer.alloc(64 * 1024);
      while (file.position < stat.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, stat.size - file.position),
          file.position
        );
        if (!bytesRead) throw new Error('Pi native source became unavailable.');
        await this.native.write(`${this.sourceRef}:file`, buffer.subarray(0, bytesRead), {
          harness: 'pi',
          format: 'pi-session-jsonl',
          runtimeOriginRef: null,
          preLaunchWatermark: file.watermark,
        });
        file.position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
  /** Records actual log pipe EOF separately from native settlement. */
  public logEnded(logSource: 'stderr' | 'stdout-log'): void {
    this.admit(async () => {
      this.native.end(`${this.sourceRef}:${logSource}`);
    }, 0);
  }

  /** Keeps actual stdout/stderr bytes separate from the host's private native channel. */
  public log(logSource: 'stderr' | 'stdout-log', bytes: Uint8Array): void {
    const original = Buffer.from(bytes);
    this.admit(
      () =>
        this.native.write(`${this.sourceRef}:${logSource}`, original, {
          harness: 'pi',
          format: 'application/octet-stream',
          runtimeOriginRef: null,
          logSource,
        }),
      original.length
    );
  }

  /** Bounds waiting native work; overflow reserves one fixed gap and drops the rest of this Turn's events. */
  private admit(work: () => Promise<void>, bytes: number): void {
    if (this.abandoned || this.limited) return;
    if (
      this.pending.length >= CAPTURE_PENDING_EVENTS ||
      this.pendingBytes + bytes > RUNTIME_FRAME_MAX_BYTES
    ) {
      this.limited = true;
      this.pending.push({ work: () => this.gap('limit-exceeded'), bytes: 0 });
    } else {
      this.pending.push({ work, bytes });
      this.pendingBytes += bytes;
    }
    if (this.draining) return;
    this.draining = true;
    // One drain owns the waiting closures. Abandonment can release them while an entered sink remains held.
    void this.enqueue(async () => {
      try {
        while (!this.abandoned && this.pending.length) {
          const next = this.pending.shift()!;
          this.pendingBytes -= next.bytes;
          await next.work();
        }
      } finally {
        this.draining = false;
      }
    }).catch(() => undefined);
  }

  /** Serializes facts at the existing source-order boundary and retains a failed publication as failure. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(() => (this.abandoned ? undefined : work()));
    void this.queue.catch(() => {
      this.pending = [];
      this.pendingBytes = 0;
    });
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
