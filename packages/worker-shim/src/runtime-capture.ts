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
  /** Known injected secret values, used only for rejection before transmission. */
  readonly credentialValues: readonly string[];
  /** Resolves after Core accepts metadata and each restricted chunk, not after local buffering. */
  readonly emit: (record: RuntimeObservation, body?: Uint8Array) => Promise<void>;
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
  const hasCredential = (value: string) =>
    values.some((secret) => secret.length > 0 && value.includes(secret)) ||
    /(?:authorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+|["'](?:api_key|apiKey|access_token|refresh_token|password|authorization|cookie)["']\s*:)/i.test(
      value
    );
  let detected = false;
  const strings = decodedContentStrings(text, (value) => {
    detected ||= hasCredential(value);
  });
  return detected || strings.some(hasCredential) || hasCredential(strings.join(''));
}
/** Emits a fact before its complete admitted body, preserving exact text and semantic JSON strings. */
export async function emitRuntimeFact(
  input: RuntimeCaptureInput,
  source: { sourceRef: string; sourceSequence: number; sourceTimestamp?: string },
  fact: RuntimeFact,
  body?: { bytes: Uint8Array; mediaType: 'text/plain' | 'application/json'; boundary: string }
): Promise<void> {
  let content: RuntimeObservation['content'] = { state: 'not-applicable' };
  let admitted: Uint8Array | undefined;
  if (body) {
    if (input.captureCoverage.value === 'off') {
      content = { state: 'off' };
    } else if (body.bytes.byteLength > RUNTIME_FRAME_MAX_BYTES) {
      content = { state: 'unavailable', reason: 'truncated' };
    } else if (
      containsCredential(Buffer.from(body.bytes).toString('utf8'), input.credentialValues)
    ) {
      content = { state: 'unavailable', reason: 'credential-excluded' };
    } else {
      admitted = body.bytes;
      content = {
        state: 'expected',
        mediaType: body.mediaType,
        boundary: body.boundary,
        bytes: body.bytes.byteLength,
        sha256: runtimeDigest(body.bytes),
        chunkCount: Math.ceil(body.bytes.byteLength / RUNTIME_CONTENT_CHUNK_BYTES),
      };
    }
  }
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
