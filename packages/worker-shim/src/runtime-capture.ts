import { createHash } from 'node:crypto';
import {
  type CaptureCoverageBinding,
  WORKER_OBSERVATION_CHUNK_MAX_BYTES,
  WORKER_OBSERVATION_CONTENT_MAX_BYTES,
  type WorkerObservationData,
  type WorkerObservationFact,
} from '@openkit/worker-protocol';

/** Metadata-only worker observation supplied by the shared worker contract. */
export type RuntimeObservation = WorkerObservationData;
/** Closed runtime fact, never a native frame or product execution authority. */
export type RuntimeFact = WorkerObservationFact;
/** Immutable admission binding and backpressured restricted publication supplied to adapters. */
export interface RuntimeCaptureInput {
  /** Exact AEP admission-time setting; adapters never resolve defaults. */
  readonly captureCoverage: CaptureCoverageBinding;
  /** Execution namespace used by the existing opaque runtime-origin algorithm. */
  readonly packageSnapshotId: string;
  /** Selected immutable AEP authority; absence never supplies a native collection default. */
  readonly nativeLogMaxBytes?: number | undefined;
  /** Authored runtime label, never a measurement of the executing binary. */
  readonly authoredVersion?: string | undefined;
  /** Known injected secret values, used only for rejection before transmission. */
  readonly credentialValues: readonly string[];
  /** Resolves after Core accepts metadata and each restricted chunk, not after local buffering. */
  readonly emit: (record: RuntimeObservation, body?: Uint8Array) => Promise<void>;
}

/** Exact supervisor-owned publication stop; it proves neither receipt nor a native terminal outcome. */
export class RuntimeCaptureStoppedError extends Error {
  /** Identifies local cancellation suppression without parsing diagnostic text. */
  public constructor() {
    super('Worker ordinary output stopped for owned cancellation.');
    this.name = 'RuntimeCaptureStoppedError';
  }
}

/** Existing semantic frame admission ceiling; overflow is a gap, not a prefix. */
export const RUNTIME_FRAME_MAX_BYTES = WORKER_OBSERVATION_CONTENT_MAX_BYTES;
/** Maximum decoded body fragment carried by the existing worker append route. */
export const RUNTIME_CONTENT_CHUNK_BYTES = WORKER_OBSERVATION_CHUNK_MAX_BYTES;

/** Returns the existing package-scoped runtime origin ref without exposing the native identity. */
export function runtimeOriginRef(packageSnapshotId: string, nativeId: string): string {
  return `rto_${createHash('sha256').update(`${packageSnapshotId}:${nativeId}`).digest('hex').slice(0, 24)}`;
}
/** Returns a bounded opaque source, message, call or observation reference. */
export function runtimeRef(prefix: string, namespace: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(`${namespace}:${value}`).digest('hex').slice(0, 24)}`;
}
/** Returns the digest of exact admitted bytes. */
export function runtimeDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** Accepts bounded native tool identifiers, never labels, paths or diagnostic prose. */
export function runtimeToolName(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : undefined;
}
/** Decodes JSON string values for admission only; retained source bytes are never transformed. */
function decodedContentStrings(text: string, inspect?: (value: string) => void): string[] {
  const pending: unknown[] = [text];
  const strings: string[] = [];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      inspect?.(value);
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === 'string' || (parsed !== null && typeof parsed === 'object'))
          pending.push(parsed);
        else strings.push(value);
      } catch {
        strings.push(value);
      }
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push(value[index]);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value).reverse()) {
        inspect?.(key);
        // Include decoded keys in secret-carrier checks, without joining them into outward text.
        if (
          /^(?:api_key|apiKey|access_token|refresh_token|password|authorization|cookie)$/i.test(key)
        )
          strings.push(`"${key}":`);
        pending.push(child);
      }
    }
  }
  return strings;
}
/** Rejects known credentials in decoded values and their logical concatenation, not arbitrary encodings. */
function containsCredential(text: string, values: readonly string[]): boolean {
  const hasCredential = (value: string) => {
    // Admission may decode JSON escapes even for a torn native frame; retained bytes stay exact.
    const decoded = value.replace(
      /\\u([0-9a-f]{4})|\\(["\\/bfnrt])/gi,
      (_match, unicode: string | undefined, escaped: string) =>
        unicode
          ? String.fromCharCode(Number.parseInt(unicode, 16))
          : (JSON.parse(`"\\${escaped}"`) as string)
    );
    return (
      values.some(
        (secret) => secret.length > 0 && (value.includes(secret) || decoded.includes(secret))
      ) ||
      /(?:authorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+|["'](?:api_key|apiKey|access_token|refresh_token|password|authorization|cookie)["']\s*:)/i.test(
        decoded
      )
    );
  };
  let detected = false;
  const strings = decodedContentStrings(text, (value) => {
    detected ||= hasCredential(value);
  });
  return detected || strings.some(hasCredential) || hasCredential(strings.join(''));
}
/** Per-admission, in-memory reservations; Core remains the durable Turn budget authority. */
const nativeAllowances = new WeakMap<
  RuntimeCaptureInput,
  { used: number; entries: Map<string, { digest: string; count: number }> }
>();

/** Emits a fact before its complete admitted body, preserving exact text and semantic JSON strings. */
export async function emitRuntimeFact(
  input: RuntimeCaptureInput,
  source: { sourceRef: string; sourceSequence: number; sourceTimestamp?: string },
  fact: RuntimeFact,
  body?: {
    bytes: Uint8Array;
    mediaType: 'text/plain' | 'application/json' | 'application/octet-stream';
    boundary: string;
  }
): Promise<void> {
  let content: RuntimeObservation['content'] = { state: 'not-applicable' };
  let admitted: Uint8Array | undefined;
  const native = fact.kind === 'native-transcript' || fact.kind === 'runtime-log';
  if (native && input.captureCoverage.value === 'off') {
    fact = { ...fact, coverage: 'off' };
    content = { state: 'off' };
  }
  if (body) {
    if (input.captureCoverage.value === 'off') {
      content = { state: 'off' };
    } else if (
      native &&
      (!Number.isSafeInteger(input.nativeLogMaxBytes) || input.nativeLogMaxBytes! <= 0)
    ) {
      content = { state: 'unavailable', reason: 'capture-failed' };
      // The source was observed; missing admission authority is a content refusal, not a collector fault.
      fact = {
        ...fact,
        native: fact.native
          ? { ...fact.native, range: null, retainedBytes: 0, omittedBytes: body.bytes.byteLength }
          : undefined,
      };
    } else if (body.bytes.byteLength > RUNTIME_FRAME_MAX_BYTES) {
      content = { state: 'unavailable', reason: 'truncated' };
    } else if (
      containsCredential(Buffer.from(body.bytes).toString('utf8'), input.credentialValues)
    ) {
      content = { state: 'unavailable', reason: 'credential-excluded' };
    } else {
      admitted = body.bytes;
      if (fact.kind === 'runtime-log' && fact.native) {
        const allowance = nativeAllowances.get(input) ?? { used: 0, entries: new Map() };
        nativeAllowances.set(input, allowance);
        const identity = `${source.sourceRef}:${source.sourceSequence}`;
        const digest = runtimeDigest(body.bytes);
        const prior = allowance.entries.get(identity);
        if (prior && prior.digest !== digest)
          throw new Error('Native log replay content conflict.');
        const count =
          prior?.count ??
          Math.min(body.bytes.byteLength, Math.max(0, input.nativeLogMaxBytes! - allowance.used));
        if (!prior) {
          allowance.used += count;
          if (count > 0) allowance.entries.set(identity, { digest, count });
        }
        admitted = body.bytes.subarray(0, count);
        fact = {
          ...fact,
          native: {
            ...fact.native,
            range: count
              ? { start: fact.native.range!.start, end: fact.native.range!.start + count }
              : null,
            retainedBytes: count,
            observedBytes: body.bytes.byteLength,
            omittedBytes: body.bytes.byteLength - count,
          },
          ...(count < body.bytes.byteLength
            ? { coverage: 'unavailable', reason: 'limit-exceeded' }
            : {}),
        };
      }
      content = {
        state: 'expected',
        mediaType: body.mediaType,
        boundary: body.boundary,
        bytes: admitted.byteLength,
        sha256: runtimeDigest(admitted),
        chunkCount: Math.ceil(admitted.byteLength / RUNTIME_CONTENT_CHUNK_BYTES),
      };
      if (native && admitted.byteLength === 0) {
        admitted = undefined;
        content = { state: 'unavailable', reason: 'truncated' };
      }
    }
  }
  if (native && body && !admitted && fact.native)
    fact = {
      ...fact,
      native: {
        ...fact.native,
        range: null,
        retainedBytes: 0,
        omittedBytes: body.bytes.byteLength,
      },
    };
  const safeFact =
    fact.toolName && containsCredential(fact.toolName, input.credentialValues)
      ? { ...fact, toolName: undefined }
      : fact;
  await input.emit(
    {
      ...source,
      observationId: runtimeRef(
        'obs',
        input.packageSnapshotId,
        `${source.sourceRef}:${source.sourceSequence}`
      ),
      observedAt: new Date().toISOString(),
      fact: safeFact,
      content,
    },
    admitted
  );
}

/** One bounded assistant message or tool argument/result, pending credential admission. */
interface RuntimeSemanticUnit {
  sourceRef: string;
  fact: RuntimeFact;
  events: Array<{ record: RuntimeObservation; body: Uint8Array }>;
  expected: Array<{ observationId: string; fact: RuntimeFact }>;
  hadExpected: boolean;
  size: number;
  reason?: 'credential-excluded' | 'truncated';
}

/** Holds exact event bytes until a semantic unit is safe, while publishing structural metadata live. */
export class RuntimeSemanticCapture {
  private readonly sequences = new Map<string, number>();
  private readonly units = new Map<string, RuntimeSemanticUnit>();
  private readonly completed = new Set<string>();
  private readonly refusedNativeUnits = new Set<string>();
  private readonly nativeUnits = new Map<
    string,
    Array<{
      fact: RuntimeFact;
      body: NonNullable<Parameters<typeof emitRuntimeFact>[3]>;
      sourceTimestamp?: string | undefined;
    }>
  >();
  /** Binds one collector to immutable admission and its existing metadata/chunk writer. */
  public constructor(private readonly input: RuntimeCaptureInput) {}
  /** Reads the next source coordinate, including for native frames without message identifiers. */
  public nextSequence(sourceRef: string): number {
    return this.sequences.get(sourceRef) ?? 0;
  }
  /** Emits metadata now; a complete native frame must then call flushCompleted(). */
  public async emit(
    sourceRef: string,
    fact: RuntimeFact,
    body?: Parameters<typeof emitRuntimeFact>[3],
    sourceTimestamp?: string
  ): Promise<void> {
    if (
      body &&
      (fact.kind === 'native-transcript' || fact.kind === 'runtime-log') &&
      this.input.captureCoverage.value === 'on'
    ) {
      if (this.refusedNativeUnits.has(sourceRef)) return;
      const unit = this.nativeUnits.get(sourceRef) ?? [];
      if (
        unit.reduce((size, event) => size + event.body.bytes.byteLength, 0) +
          body.bytes.byteLength >
        RUNTIME_FRAME_MAX_BYTES
      ) {
        await emitRuntimeFact(
          this.input,
          { sourceRef, sourceSequence: this.nextSequence(sourceRef) },
          {
            ...fact,
            coverage: 'unavailable',
            reason: 'limit-exceeded',
            native: fact.native
              ? { ...fact.native, range: null, retainedBytes: 0, omittedBytes: null }
              : undefined,
          }
        );
        this.nativeUnits.delete(sourceRef);
        this.refusedNativeUnits.add(sourceRef);
        return;
      }
      unit.push({ fact, body: { ...body, bytes: Buffer.from(body.bytes) }, sourceTimestamp });
      this.nativeUnits.set(sourceRef, unit);
      return;
    }
    const sourceSequence = this.nextSequence(sourceRef);
    this.sequences.set(sourceRef, sourceSequence + 1);
    const source = { sourceRef, sourceSequence, ...(sourceTimestamp ? { sourceTimestamp } : {}) };
    const prefix = `${sourceRef}:${fact.kind}:${fact.messageRef ?? fact.callRef}:`;
    const terminal = ['completed', 'failed', 'interrupted', 'closed'].includes(fact.phase ?? '');
    if (!body || this.input.captureCoverage.value === 'off') {
      await emitRuntimeFact(this.input, source, fact, body);
      if (terminal)
        for (const key of this.units.keys()) if (key.startsWith(prefix)) this.completed.add(key);
      return;
    }
    const key = prefix + body.boundary;
    let unit = this.units.get(key);
    if (!unit) {
      unit = { sourceRef, fact, events: [], expected: [], hadExpected: false, size: 0 };
      this.units.set(key, unit);
    }
    unit.fact = fact;
    unit.size += Math.max(1, body.bytes.byteLength);
    if (unit.size > RUNTIME_FRAME_MAX_BYTES) {
      unit.reason = 'truncated';
      unit.events = [];
    }
    const current = unit;
    await emitRuntimeFact(
      {
        ...this.input,
        emit: async (record, admitted) => {
          if (record.content.state === 'expected') {
            current.expected.push({ observationId: record.observationId, fact: record.fact });
            current.hadExpected = true;
          }
          if (record.content.state === 'unavailable') {
            current.reason =
              record.content.reason === 'credential-excluded' ? 'credential-excluded' : 'truncated';
            current.events = [];
          }
          if (admitted && !current.reason)
            current.events.push({ record, body: Buffer.from(admitted) });
          await this.input.emit(record);
        },
      },
      source,
      fact,
      body
    );
    if (unit.reason && unit.expected.length) await this.reportUnavailable(unit, false);
    if (terminal || body.boundary === 'runtime.tool.arguments') this.completed.add(key);
  }
  /** Completes all terminal units only after every sibling field in the native frame was observed. */
  public async flushCompleted(): Promise<void> {
    for (const key of this.completed) await this.flush(key, false);
    this.completed.clear();
  }
  /** Scans finite interrupted prefixes; a process crash instead leaves metadata expected and unpublished. */
  public async interrupt(): Promise<void> {
    for (const [sourceRef, events] of this.nativeUnits) {
      this.nativeUnits.delete(sourceRef);
      const excluded = containsCredential(
        Buffer.concat(events.map(({ body }) => Buffer.from(body.bytes))).toString('utf8'),
        this.input.credentialValues
      );
      for (const { fact, body, sourceTimestamp } of events) {
        const sourceSequence = this.nextSequence(sourceRef);
        this.sequences.set(sourceRef, sourceSequence + 1);
        await emitRuntimeFact(
          excluded
            ? {
                ...this.input,
                emit: (record) =>
                  this.input.emit({
                    ...record,
                    content: { state: 'unavailable', reason: 'credential-excluded' },
                  }),
              }
            : this.input,
          { sourceRef, sourceSequence, ...(sourceTimestamp ? { sourceTimestamp } : {}) },
          excluded
            ? {
                ...fact,
                coverage: 'unavailable',
                reason: 'collector-failed',
                native: fact.native
                  ? {
                      ...fact.native,
                      range: null,
                      retainedBytes: 0,
                      omittedBytes: body.bytes.byteLength,
                    }
                  : undefined,
              }
            : fact,
          excluded ? undefined : body
        );
      }
    }
    for (const key of this.units.keys()) await this.flush(key, true);
    this.completed.clear();
  }
  /** Publishes original events only after the entire decoded semantic unit passes admission. */
  private async flush(key: string, interrupted: boolean): Promise<void> {
    const unit = this.units.get(key);
    if (!unit) return;
    this.units.delete(key);
    if (
      !unit.reason &&
      containsCredential(
        unit.events
          .flatMap(({ body }) => decodedContentStrings(Buffer.from(body).toString('utf8')))
          .join(''),
        this.input.credentialValues
      )
    )
      unit.reason = 'credential-excluded';
    if (unit.reason) {
      const anchorsAlreadyReported = unit.hadExpected && unit.expected.length === 0;
      if (unit.reason === 'truncated')
        await this.emit(unit.sourceRef, {
          kind: 'coverage',
          runtimeOriginRef: unit.fact.runtimeOriginRef,
          family: 'primary-content',
          coverage: 'unavailable',
          reason: 'limit-exceeded',
        });
      await this.reportUnavailable(unit, interrupted);
      if (interrupted && anchorsAlreadyReported)
        await this.emit(unit.sourceRef, { ...unit.fact, phase: 'interrupted' });
    } else {
      if (interrupted) await this.emit(unit.sourceRef, { ...unit.fact, phase: 'interrupted' });
      for (const { record, body } of unit.events) await this.input.emit(record, body);
    }
  }

  /** Flushes rejected metadata anchors without retaining later rejected frames in the unit. */
  private async reportUnavailable(unit: RuntimeSemanticUnit, interrupted: boolean): Promise<void> {
    const expected = unit.expected.splice(0);
    if (!expected.length && unit.hadExpected) return;
    for (const entry of expected.length
      ? expected
      : [{ observationId: undefined, fact: unit.fact }]) {
      const sourceSequence = this.nextSequence(unit.sourceRef);
      this.sequences.set(unit.sourceRef, sourceSequence + 1);
      await emitRuntimeFact(
        {
          ...this.input,
          emit: (record) =>
            this.input.emit({
              ...record,
              content: {
                state: 'unavailable',
                reason: unit.reason!,
                ...(entry.observationId ? { expectedObservationId: entry.observationId } : {}),
              },
            }),
        },
        { sourceRef: unit.sourceRef, sourceSequence },
        { ...entry.fact, ...(interrupted ? { phase: 'interrupted' as const } : {}) }
      );
    }
  }
}

/** Backpressured parent-only JSON stream capture for adapters without an admitted child source. */
export class ParentRuntimeCapture {
  private readonly semantic: RuntimeSemanticCapture;
  private started = false;
  private stopped = false;
  private readonly reader: RuntimeJsonlReader;
  private readonly sourceRef: string;
  /** Binds one adapter's positive-selecting interpreter to the common admission/publication boundary. */
  public constructor(
    private readonly input: RuntimeCaptureInput,
    interpret: (
      record: Record<string, unknown>,
      emit: (fact: RuntimeFact, body?: Parameters<typeof emitRuntimeFact>[3]) => Promise<void>
    ) => Promise<void>
  ) {
    this.sourceRef = runtimeRef('rts', input.packageSnapshotId, 'stdout');
    this.semantic = new RuntimeSemanticCapture(input);
    this.reader = new RuntimeJsonlReader(async (bytes, _sequence, failure) => {
      if (!bytes) {
        await this.gap(failure!);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        await this.gap('malformed-frame');
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        await this.gap('malformed-frame');
        return;
      }
      await interpret(value as Record<string, unknown>, (fact, body) => this.emit(fact, body));
      await this.semantic.flushCompleted();
    });
  }
  /** Reports unsupported child coverage once before consuming any available parent content. */
  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
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
  }
  /** Consumes one live chunk under the shared parser ceiling. */
  public async writeStdout(bytes: Uint8Array): Promise<void> {
    if (this.stopped) throw new Error('Runtime capture is stopped.');
    await this.start();
    await this.reader.write(bytes);
  }
  /** Reports the finite parser tail and collector end, not universal content completeness. */
  public async finalize(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.start();
    await this.reader.finish();
    await this.semantic.interrupt();
    await this.emit({
      kind: 'coverage',
      runtimeOriginRef: null,
      family: 'primary-content',
      coverage: 'ended',
    });
  }
  /** Stops collection after native lifecycle failure without replaying external work. */
  public async invalidate(): Promise<void> {
    this.stopped = true;
    await this.semantic.interrupt();
  }
  /** Emits a source-ordered semantic fact. */
  private emit(fact: RuntimeFact, body?: Parameters<typeof emitRuntimeFact>[3]): Promise<void> {
    return this.semantic.emit(this.sourceRef, fact, body);
  }
  /** Emits a bounded malformed, partial or oversized-source gap. */
  private gap(reason: 'malformed-frame' | 'partial-frame' | 'limit-exceeded'): Promise<void> {
    return this.emit({
      kind: 'coverage',
      runtimeOriginRef: null,
      family: 'primary-content',
      coverage: 'unavailable',
      reason,
    });
  }
}

/** One bounded physical JSONL decoder, shared by the live native stream consumers. */
export class RuntimeJsonlReader {
  private pending: Buffer[] = [];
  private size = 0;
  private oversized = false;
  private sequence = 0;
  /** Creates an LF-framed reader whose callback is awaited before accepting more input. */
  public constructor(
    private readonly onFrame: (
      bytes: Uint8Array | null,
      sequence: number,
      failure?: 'limit-exceeded' | 'partial-frame'
    ) => Promise<void>
  ) {}
  /** Consumes chunks without splitting Unicode or treating an unfinished line as a record. */
  public async write(chunk: Uint8Array): Promise<void> {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline + 1;
      const part = bytes.subarray(start, end);
      this.size += part.length;
      if (this.size > RUNTIME_FRAME_MAX_BYTES && !this.oversized) {
        this.oversized = true;
        this.pending = [];
        await this.onFrame(null, this.sequence++, 'limit-exceeded');
      } else if (!this.oversized) {
        this.pending.push(Buffer.from(part));
      }
      if (newline >= 0) {
        if (!this.oversized) await this.onFrame(Buffer.concat(this.pending), this.sequence++);
        this.pending = [];
        this.size = 0;
        this.oversized = false;
      }
      start = end;
    }
  }
  /** Reports, rather than interpreting, any remaining unterminated physical frame. */
  public async finish(): Promise<void> {
    if (this.size > 0) {
      if (!this.oversized) await this.onFrame(null, this.sequence++, 'partial-frame');
      this.pending = [];
      this.size = 0;
      this.oversized = false;
    }
  }
}

/** One existing native source and its exact byte coordinate system. */
export interface NativeCaptureSource {
  readonly harness: string;
  readonly format: string;
  readonly runtimeOriginRef: string | null;
  readonly preLaunchWatermark?: number;
  readonly logSource?: 'stderr' | 'stdout-log';
}

/** Bounded raw-byte admission shared by adapter sources, before structural interpretation. */
export class NativeRuntimeCapture {
  private readonly positions = new Map<string, number>();
  private readonly sequences = new Map<string, number>();
  private pending: Array<{
    sourceRef: string;
    source: NativeCaptureSource;
    bytes: Buffer;
    start: number;
  }> = [];
  private readonly blocked = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private stopped = false;
  private abandoned = false;
  private finishing: Promise<void> | undefined;
  private readonly ended = new Set<string>();
  private readonly lookbehind: number;
  private readonly unboundedSecret: boolean;
  private queuedBytes = 0;
  private overflow: Error | undefined;
  /** Shares the adapter's immutable admission and existing publication sink. */
  public constructor(private readonly input: RuntimeCaptureInput) {
    const required = Math.max(
      64 * 1024,
      ...input.credentialValues.map((value) => Buffer.byteLength(value) * 6 + 64)
    );
    this.unboundedSecret = required > RUNTIME_FRAME_MAX_BYTES;
    this.lookbehind = Math.min(RUNTIME_FRAME_MAX_BYTES, required);
  }
  /**
   * Admits an observed frame before structural parsing, in bounded publication pieces.
   * Oversized SDK-owned frames remain borrowed until this promise settles; those callers await it.
   * Pipe/read buffers inside the existing ceiling are copied immediately before their caller can reuse them.
   */
  public write(sourceRef: string, bytes: Uint8Array, source: NativeCaptureSource): Promise<void> {
    if (this.stopped) return Promise.reject(this.failure ?? new Error('Native capture stopped.'));
    if (this.overflow) return Promise.reject(this.overflow);
    const retaining =
      this.input.captureCoverage.value === 'on' &&
      Number.isSafeInteger(this.input.nativeLogMaxBytes) &&
      this.input.nativeLogMaxBytes! > 0;
    const charge = retaining ? Math.min(bytes.byteLength, RUNTIME_FRAME_MAX_BYTES) : 0;
    if (
      (retaining && this.unboundedSecret) ||
      this.queuedBytes + charge > RUNTIME_FRAME_MAX_BYTES
    ) {
      this.overflow = new Error('Native capture backlog exceeded its limit.');
      return this.enqueue(async () => {
        const start = this.positions.get(sourceRef) ?? source.preLaunchWatermark ?? 0;
        await this.publish(
          { sourceRef, source, bytes: Buffer.alloc(0), start },
          false,
          'limit-exceeded'
        );
        throw this.overflow;
      });
    }
    const frame =
      retaining && bytes.byteLength <= RUNTIME_FRAME_MAX_BYTES
        ? Buffer.from(bytes)
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.queuedBytes += charge;
    return this.enqueue(async () => {
      if (this.ended.has(sourceRef)) throw new Error('Native source wrote after EOF.');
      if (!retaining) {
        const start = this.positions.get(sourceRef) ?? source.preLaunchWatermark ?? 0;
        this.positions.set(sourceRef, start + frame.length);
        // OFF or missing authority cannot impose a new runtime-result size bound.
        // Only byte counts are consumed here; emitRuntimeFact refuses all body transfer.
        await this.publish({ sourceRef, source, bytes: frame, start }, false);
        return;
      }
      for (let offset = 0; offset < frame.length; offset += 64 * 1024) {
        if (this.abandoned) return;
        const copy = Buffer.from(
          frame.subarray(offset, Math.min(frame.length, offset + 64 * 1024))
        );
        const start = this.positions.get(sourceRef) ?? source.preLaunchWatermark ?? 0;
        this.positions.set(sourceRef, start + copy.length);
        if (this.blocked.has(sourceRef)) continue;
        this.pending.push({ sourceRef, source, bytes: copy, start });
        const related = this.pending.filter((entry) => entry.sourceRef === sourceRef);
        const joined = Buffer.concat(related.map((entry) => entry.bytes));
        if (containsCredential(joined.toString('utf8'), this.input.credentialValues)) {
          this.blocked.add(sourceRef);
          this.pending = this.pending.filter((entry) => entry.sourceRef !== sourceRef);
          await this.publish(
            { sourceRef, source, bytes: Buffer.alloc(0), start },
            false,
            'credential-excluded',
            'credential-excluded'
          );
          continue;
        }
        // Keep a bounded suffix until later bytes decide split credential/UTF-8 admission.
        let waiting = joined.length;
        while (waiting > this.lookbehind + 64 * 1024) {
          const index = this.pending.findIndex((entry) => entry.sourceRef === sourceRef);
          const entry = this.pending[index]!;
          if (waiting - entry.bytes.length < this.lookbehind) break;
          this.pending.splice(index, 1);
          waiting -= entry.bytes.length;
          await this.publish(entry, false);
        }
      }
    }).finally(() => {
      this.queuedBytes -= charge;
    });
  }
  /** Drains observed source bytes without claiming native execution completion. */
  public finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.stopped = true;
    this.finishing = this.enqueue(async () => {
      for (const entry of this.pending.splice(0)) await this.publish(entry, false);
      for (const [sourceRef, position] of this.positions) {
        const source = this.sources.get(sourceRef);
        if (source)
          await this.publish(
            { sourceRef, source, start: position, bytes: Buffer.alloc(0) },
            this.ended.has(sourceRef),
            this.blocked.has(sourceRef) ? 'credential-excluded' : undefined
          );
      }
    });
    return this.finishing;
  }
  /** Records readable EOF only when the adapter actually observes it. */
  public end(sourceRef: string): void {
    void this.enqueue(async () => {
      this.ended.add(sourceRef);
    }).catch(() => undefined);
  }
  /** Stops future publication on the adapter's existing abandonment boundary. */
  public abandon(): void {
    this.abandoned = true;
    this.stopped = true;
    this.pending = [];
  }
  private readonly sources = new Map<string, NativeCaptureSource>();
  /** Serializes all pipes/sources in observed order and preserves an entered publication failure. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      if (!this.abandoned) await work();
    });
    this.queue = result.catch((error: unknown) => {
      this.failure ??= error;
    });
    return result;
  }
  /** Emits exact ranges through the same expected/body publication owner as semantic capture. */
  private async publish(
    entry: { sourceRef: string; source: NativeCaptureSource; bytes: Buffer; start: number },
    sourceEnded: boolean,
    reason?: 'collector-failed' | 'limit-exceeded' | 'credential-excluded',
    contentReason?: 'credential-excluded'
  ): Promise<void> {
    if (this.abandoned) return;
    const { sourceRef, source, bytes, start } = entry;
    this.sources.set(sourceRef, source);
    const sourceSequence = this.sequences.get(sourceRef) ?? 0;
    this.sequences.set(sourceRef, sourceSequence + 1);
    await emitRuntimeFact(
      contentReason
        ? {
            ...this.input,
            emit: (record) =>
              this.input.emit({
                ...record,
                content: { state: 'unavailable', reason: contentReason },
              }),
          }
        : this.input,
      { sourceRef, sourceSequence },
      {
        kind: source.logSource ? 'runtime-log' : 'native-transcript',
        runtimeOriginRef: source.runtimeOriginRef,
        coverage:
          this.input.captureCoverage.value === 'off'
            ? 'off'
            : reason
              ? 'unavailable'
              : 'collecting',
        ...(reason ? { reason } : {}),
        native: {
          harness: source.harness,
          authoredVersion: this.input.authoredVersion ?? 'unknown',
          measuredVersion: null,
          imageDigest: null,
          format: source.format,
          preLaunchWatermark: source.preLaunchWatermark ?? 0,
          range: { start, end: start + bytes.length },
          observedBytes: bytes.length,
          retainedBytes: bytes.length,
          omittedBytes: reason ? null : 0,
          sourceEnded,
          ...(source.logSource ? { logSource: source.logSource } : {}),
        },
      },
      bytes.length
        ? { bytes, mediaType: 'application/octet-stream', boundary: 'native-content-v1' }
        : undefined
    );
  }
}

/**
 * Selects exact member text from an already owner-validated JSON envelope without reserializing values.
 * This framing walk supplies native bytes; structural extraction remains the adapter's separate job.
 */
export function nativeJsonMember(text: string, path: readonly string[]): string | undefined {
  const space = (offset: number): number => {
    while (offset < text.length && /\s/.test(text[offset]!)) offset++;
    return offset;
  };
  const end = (start: number): number => {
    let quoted = false;
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      const character = text[index]!;
      if (quoted) {
        if (character === '\\') index++;
        else if (character === '"') {
          quoted = false;
          if (!depth) return index + 1;
        }
      } else if (character === '"') quoted = true;
      else if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') {
        if (!depth) return index;
        if (--depth === 0) return index + 1;
      } else if (!depth && (character === ',' || /\s/.test(character))) return index;
    }
    return text.length;
  };
  let offset = space(0);
  for (const member of path) {
    if (text[offset] !== '{') return undefined;
    offset = space(offset + 1);
    let selected: number | undefined;
    while (offset < text.length && text[offset] !== '}') {
      if (text[offset] !== '"') return undefined;
      const keyEnd = end(offset);
      const key: unknown = JSON.parse(text.slice(offset, keyEnd));
      offset = space(keyEnd);
      if (text[offset] !== ':') return undefined;
      offset = space(offset + 1);
      if (key === member) selected = offset;
      offset = space(end(offset));
      if (text[offset] === '}') break;
      if (text[offset] !== ',') return undefined;
      offset = space(offset + 1);
    }
    if (selected === undefined) return undefined;
    offset = selected;
  }
  return text.slice(offset, end(offset));
}
