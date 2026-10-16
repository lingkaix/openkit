import { createHash } from 'node:crypto';

/** Source-body ceilings are independent of the serialized result budget. LF terminates a line. */
export const SOURCE_PREVIEW_LIMITS = Object.freeze({ bytes: 2_048, lines: 50 });
/** Requested reads stop at either the byte ceiling or the line ceiling. */
export const SOURCE_READ_LIMITS = Object.freeze({ bytes: 51_200, lines: 2_000 });
const MAX_READ_BYTES = 65_536;
const MAX_IDENTITY_BYTES = 2_048;
const MAX_ENVELOPE_BYTES = 65_536;
const MIN_ENVELOPE_BYTES = 128;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** The source owner admits the original; this reader verifies the separate text representation. */
export interface SourceViewIdentity {
  readonly sourceKey: string;
  readonly revision: string;
  readonly originalDigest: string;
  readonly representationId: string;
  readonly representationDigest: string;
}

/** Caller-owned immutable bytes. Keep the admitted handle alive until all calls settle. Reads must honor cancellation, use explicit positions, and return at most the requested bytes; an empty read means EOF. assertUnchanged must prove the held source and its immutable owner are unchanged, including before and after reads. No path acquisition or authorization occurs here. */
export interface BoundedByteSource {
  readonly identity: SourceViewIdentity;
  readonly byteLength: number;
  read(offset: number, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  assertUnchanged(signal: AbortSignal): void | Promise<void>;
}

/** Caller-admitted resource budgets. No upload-size ceiling is imposed on derived text. */
export interface SourceViewLimits {
  readonly maxRepresentationBytes: number;
  readonly timeoutMs: number;
  readonly maxEnvelopeBytes: number;
}

/** Fixed-size continuation for the same logical source, revision, original and representation. It grants no access. */
export interface SourceViewCursor {
  readonly version: 1;
  readonly mode: 'read';
  readonly binding: string;
  readonly range: { readonly start: number; readonly end: number };
}

/** Closed, value-free failures do not expose paths, source metadata, bytes, or a usable cursor. */
const UNAVAILABLE_REASONS = [
  'unsupported',
  'invalid_utf8',
  'missing',
  'corrupt',
  'stale',
  'resource_limited',
  'cancelled',
  'invalid_request',
  'unavailable',
] as const;
/** Closed failure vocabulary shared by adapters and bounded result consumers. */
export type SourceViewUnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
/** A failure result has no body, source metadata, or continuation handle. */
export interface SourceViewUnavailable {
  readonly status: 'unavailable';
  readonly reason: SourceViewUnavailableReason;
}

/** Source adapters may classify a known refusal without forwarding an underlying diagnostic. */
export class BoundedSourceError extends Error {
  /** Retains only a closed reason at this private adapter boundary. */
  constructor(readonly reason: SourceViewUnavailableReason) {
    super('The source representation is unavailable.');
    this.name = 'BoundedSourceError';
  }
}

/** A half-open range in the named representation's exact UTF-8 bytes. Derived offsets never claim binary-original coordinates. */
export interface SourceViewPage {
  readonly status: 'ready';
  readonly identity: SourceViewIdentity;
  readonly representationByteLength: number;
  readonly range: {
    readonly representationId: string;
    readonly start: number;
    readonly end: number;
  };
  readonly mode: 'preview' | 'read';
  readonly requestedRange: { readonly start: number; readonly end: number };
  readonly omittedRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  readonly text: string;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly eof: boolean;
  readonly cursor: SourceViewCursor | null;
}
/** One bounded page or a fixed unavailable result. */
export type SourceViewResult = SourceViewPage | SourceViewUnavailable;

/** An ephemeral reader, available only after complete representation verification. The caller still owns current source and destination authorization. */
export interface BoundedSourceView {
  readonly status: 'ready';
  preview(signal?: AbortSignal): Promise<SourceViewResult>;
  read(cursor?: SourceViewCursor, signal?: AbortSignal): Promise<SourceViewResult>;
}

/** Validates the complete representation with bounded reads, SHA-256 and strict streaming UTF-8. No full-body copy, registry, storage, or background work is retained. Each later range rechecks the source; callers must supply fresh admission after access changes. */
export async function openBoundedSourceView(
  source: BoundedByteSource,
  limits: SourceViewLimits,
  signal?: AbortSignal
): Promise<BoundedSourceView | SourceViewUnavailable> {
  if (signal?.aborted) return unavailable('cancelled');
  if (!validLimits(limits) || !validSource(source)) return unavailable('invalid_request');
  if (source.byteLength > limits.maxRepresentationBytes) return unavailable('resource_limited');
  const { timeoutMs, maxEnvelopeBytes } = limits;
  const identity: SourceViewIdentity = Object.freeze({
    sourceKey: source.identity.sourceKey,
    revision: source.identity.revision,
    originalDigest: source.identity.originalDigest,
    representationId: source.identity.representationId,
    representationDigest: source.identity.representationDigest,
  });
  const byteLength = source.byteLength;
  const binding = bind(identity, byteLength);
  const read = source.read.bind(source);
  const assertUnchanged = source.assertUnchanged.bind(source);
  const assertPinned = async (budget: ReadBudget) => {
    if (!validSource(source) || bind(source.identity, source.byteLength) !== binding)
      throw new BoundedSourceError('stale');
    await budget.step(() => assertUnchanged(budget.signal));
    if (!validSource(source) || bind(source.identity, source.byteLength) !== binding)
      throw new BoundedSourceError('stale');
  };
  const readBytes = async (offset: number, length: number, budget: ReadBudget) => {
    const bytes = await budget.step(() => read(offset, length, budget.signal));
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > length)
      throw new BoundedSourceError('corrupt');
    return bytes;
  };

  const verification = new ReadBudget(timeoutMs, signal);
  try {
    await assertPinned(verification);
    const hash = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let offset = 0;
    while (offset < byteLength) {
      const bytes = await readBytes(
        offset,
        Math.min(MAX_READ_BYTES, byteLength - offset),
        verification
      );
      if (!bytes.byteLength) throw new BoundedSourceError('corrupt');
      hash.update(bytes);
      decode(decoder, bytes, true);
      offset += bytes.byteLength;
    }
    decode(decoder, new Uint8Array(), false);
    // The one-byte probe detects a false declared EOF, including for an empty source.
    if ((await readBytes(byteLength, 1, verification)).byteLength)
      throw new BoundedSourceError('corrupt');
    if (`sha256:${hash.digest('hex')}` !== identity.representationDigest)
      throw new BoundedSourceError('corrupt');
    await assertPinned(verification);
  } catch (error) {
    return refusal(error);
  } finally {
    verification.dispose();
  }

  const page = async (
    cursor: SourceViewCursor | undefined,
    bounds: { readonly bytes: number; readonly lines: number },
    mode: 'preview' | 'read',
    pageSignal?: AbortSignal
  ): Promise<SourceViewResult> => {
    const budget = new ReadBudget(timeoutMs, pageSignal);
    try {
      await assertPinned(budget);
      if (cursor !== undefined && !validCursor(cursor, byteLength))
        throw new BoundedSourceError('invalid_request');
      if (cursor && cursor.binding !== cursorBinding(binding, cursor.range))
        throw new BoundedSourceError('stale');
      const start = cursor?.range.start ?? 0;
      const requestedRange = { start, end: start + Math.min(bounds.bytes, byteLength - start) };
      // Three lookahead bytes distinguish a complete boundary from a cut four-byte code point.
      const length = Math.min(bounds.bytes + 3, byteLength - start);
      const bytes = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const next = await readBytes(start + filled, length - filled, budget);
        if (!next.byteLength) throw new BoundedSourceError('corrupt');
        bytes.set(next, filled);
        filled += next.byteLength;
      }
      if (bytes.length && (bytes[0]! & 0xc0) === 0x80)
        throw new BoundedSourceError('invalid_request');
      let end = utf8Boundary(bytes, Math.min(bounds.bytes, length));
      let newlines = 0;
      for (let offset = 0; offset < end; offset += 1) {
        if (bytes[offset] === 10 && ++newlines === bounds.lines) {
          end = offset + 1;
          break;
        }
      }
      const resultAt = (count: number): SourceViewPage => {
        const selected = bytes.subarray(0, count);
        const rangeEnd = start + count;
        const eof = rangeEnd === byteLength;
        return {
          status: 'ready',
          identity,
          representationByteLength: byteLength,
          range: { representationId: identity.representationId, start, end: rangeEnd },
          mode,
          requestedRange,
          omittedRanges: [
            ...(start > 0 ? [{ start: 0, end: start }] : []),
            ...(rangeEnd < byteLength ? [{ start: rangeEnd, end: byteLength }] : []),
          ],
          text: decode(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), selected, false),
          lineCount: countLines(selected),
          truncated: start > 0 || rangeEnd < byteLength,
          eof,
          cursor: eof
            ? null
            : {
                version: 1,
                mode: 'read',
                range: {
                  start: rangeEnd,
                  end: rangeEnd + Math.min(SOURCE_READ_LIMITS.bytes, byteLength - rangeEnd),
                },
                binding: cursorBinding(binding, {
                  start: rangeEnd,
                  end: rangeEnd + Math.min(SOURCE_READ_LIMITS.bytes, byteLength - rangeEnd),
                }),
              },
        };
      };
      let result = resultAt(end);
      if (serializedBytes(result) > maxEnvelopeBytes) {
        let low = 0;
        let high = end;
        // Search byte offsets, always rounding toward an earlier complete code point.
        while (low < high) {
          budget.check();
          const middle = Math.ceil((low + high) / 2);
          if (serializedBytes(resultAt(utf8Boundary(bytes, middle))) <= maxEnvelopeBytes)
            low = middle;
          else high = middle - 1;
        }
        end = utf8Boundary(bytes, low);
        result = resultAt(end);
      }
      if (serializedBytes(result) > maxEnvelopeBytes || (!result.eof && result.range.end === start))
        throw new BoundedSourceError('resource_limited');
      await assertPinned(budget);
      return result;
    } catch (error) {
      return refusal(error);
    } finally {
      budget.dispose();
    }
  };
  return {
    status: 'ready',
    preview: (pageSignal) => page(undefined, SOURCE_PREVIEW_LIMITS, 'preview', pageSignal),
    read: (cursor, pageSignal) => page(cursor, SOURCE_READ_LIMITS, 'read', pageSignal),
  };
}

/** Owns one finite operation deadline and a bounded number of cancellation listeners. Trusted source callbacks must not block synchronously. */
class ReadBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly startedAt = performance.now();
  private readonly timer: ReturnType<typeof setTimeout>;
  private reason: 'cancelled' | 'resource_limited' | undefined;
  private readonly onExternalAbort = () => this.stop('cancelled');

  /** Starts one caller-admitted deadline and forwards cancellation to the source. */
  constructor(
    private readonly timeoutMs: number,
    private readonly external?: AbortSignal
  ) {
    this.signal = this.controller.signal;
    external?.addEventListener('abort', this.onExternalAbort, { once: true });
    this.timer = setTimeout(() => this.stop('resource_limited'), timeoutMs);
  }

  /** Checks the monotonic clock even when an inline source resolves only through microtasks. */
  check(): void {
    if (this.external?.aborted) this.stop('cancelled');
    if (performance.now() - this.startedAt >= this.timeoutMs) this.stop('resource_limited');
    if (this.reason) throw new BoundedSourceError(this.reason);
  }

  /** Bounds an asynchronous source call without retaining listeners across successful reads. */
  async step<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.check();
    let onAbort = () => {};
    try {
      const value = await new Promise<T>((resolve, reject) => {
        onAbort = () => reject(new BoundedSourceError(this.reason ?? 'cancelled'));
        this.signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve().then(operation).then(resolve, reject);
      });
      this.check();
      return value;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Drops timers and external references after this operation settles. */
  dispose(): void {
    clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.onExternalAbort);
  }

  /** Keeps the first stopping cause and aborts the pending owner call. */
  private stop(reason: 'cancelled' | 'resource_limited'): void {
    this.reason ??= reason;
    this.controller.abort();
  }
}

/** Refuses oversized identity input before JSON serialization or echoing any metadata. */
function validIdentity(identity: SourceViewIdentity): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const fields = [
    identity.sourceKey,
    identity.revision,
    identity.originalDigest,
    identity.representationId,
    identity.representationDigest,
  ];
  let total = 0;
  for (const value of fields) {
    if (typeof value !== 'string' || !value.length || value.length > MAX_IDENTITY_BYTES)
      return false;
    total += Buffer.byteLength(value, 'utf8');
    if (total > MAX_IDENTITY_BYTES || Buffer.from(value, 'utf8').toString('utf8') !== value)
      return false;
  }
  return DIGEST.test(identity.originalDigest) && DIGEST.test(identity.representationDigest);
}

/** Validates caller-admitted source and representation metadata without acquiring bytes. */
function validSource(source: BoundedByteSource): boolean {
  return (
    !!source &&
    validIdentity(source.identity) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength >= 0 &&
    typeof source.read === 'function' &&
    typeof source.assertUnchanged === 'function'
  );
}

/** Keeps timers and serialized responses inside explicit finite implementation ceilings. */
function validLimits(limits: SourceViewLimits): boolean {
  return (
    !!limits &&
    Number.isSafeInteger(limits.maxRepresentationBytes) &&
    limits.maxRepresentationBytes >= 0 &&
    Number.isFinite(limits.timeoutMs) &&
    limits.timeoutMs > 0 &&
    limits.timeoutMs <= 2_147_483_647 &&
    Number.isSafeInteger(limits.maxEnvelopeBytes) &&
    limits.maxEnvelopeBytes >= MIN_ENVELOPE_BYTES &&
    limits.maxEnvelopeBytes <= MAX_ENVELOPE_BYTES
  );
}

/** Pins immutable core identity; budgets and unknown descriptive additions do not change source identity. */
function bind(identity: SourceViewIdentity, byteLength: number): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        identity.sourceKey,
        identity.revision,
        identity.originalDigest,
        identity.representationId,
        identity.representationDigest,
        byteLength,
      ])
    )
    .digest('hex')}`;
}

/** Treats a cursor as untrusted input; an offset cannot exceed the pinned representation. */
function validCursor(cursor: SourceViewCursor, byteLength: number): boolean {
  return (
    !!cursor &&
    typeof cursor === 'object' &&
    cursor.version === 1 &&
    cursor.mode === 'read' &&
    typeof cursor.binding === 'string' &&
    cursor.binding.length === 71 &&
    DIGEST.test(cursor.binding) &&
    !!cursor.range &&
    Number.isSafeInteger(cursor.range.start) &&
    cursor.range.start >= 0 &&
    cursor.range.start <= byteLength &&
    Number.isSafeInteger(cursor.range.end) &&
    cursor.range.end ===
      cursor.range.start + Math.min(SOURCE_READ_LIMITS.bytes, byteLength - cursor.range.start)
  );
}

/** A preview deliberately continues as a read request. Its exact next range is part of the binding. */
function cursorBinding(
  sourceBinding: string,
  range: { readonly start: number; readonly end: number }
): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([sourceBinding, 'read', range.start, range.end]))
    .digest('hex')}`;
}

/** Finds a boundary at or before the candidate offset; lookahead covers an incomplete tail. */
function utf8Boundary(bytes: Uint8Array, end: number): number {
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

/** Counts LF-terminated lines and any final nonempty line fragment, preserving CR and BOM bytes. */
function countLines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 10) count += 1;
  return count + (bytes.length && bytes.at(-1) !== 10 ? 1 : 0);
}

/** Never replaces invalid UTF-8 or strips a BOM from exact representation bytes. */
function decode(decoder: TextDecoder, bytes: Uint8Array, stream: boolean): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new BoundedSourceError('invalid_utf8');
  }
}

/** Measures the full result, including escaped text, identity, range, continuation, and status. */
function serializedBytes(result: SourceViewPage): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/** Produces a fixed-size, content-free descriptor. */
function unavailable(reason: SourceViewUnavailableReason): SourceViewUnavailable {
  return { status: 'unavailable', reason };
}

/** Classifies trusted source refusals and ordinary missing-file errors without exposing messages. */
function refusal(error: unknown): SourceViewUnavailable {
  if (error instanceof BoundedSourceError && UNAVAILABLE_REASONS.includes(error.reason))
    return unavailable(error.reason);
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return unavailable(
    code === 'ENOENT' || code === 'ENOTDIR'
      ? 'missing'
      : code === 'ABORT_ERR'
        ? 'cancelled'
        : 'unavailable'
  );
}
