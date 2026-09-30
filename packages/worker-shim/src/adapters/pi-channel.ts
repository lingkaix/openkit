/**
 * Private frame codec for the Pi runtime host channel.
 *
 * The host owns the schema in `@openkit/pi-runtime-host`. This module is a narrow reader for the
 * supervising adapter: it does not import that package, ignores unknown event names, and fails
 * closed when a field the adapter relies on has an unknown shape. The production frame bound is
 * the host's outbound maximum.
 */

/** Maximum bytes of one request line the host accepts. */
export const PI_CHANNEL_REQUEST_MAX_BYTES = 8 * 1024 * 1024;
/** Maximum UTF-8 bytes of one final assistant text the adapter will admit. */
export const PI_RESULT_CONTENT_MAX_BYTES = 16 * 1024 * 1024;
/** Maximum bytes of one host frame, matching the host's outbound bound. */
export const PI_CHANNEL_FRAME_MAX_BYTES = 6 * PI_RESULT_CONTENT_MAX_BYTES + 64 * 1024;
/** Maximum bytes of one Turn prompt. */
export const PI_PROMPT_MAX_BYTES = 4 * 1024 * 1024;
/** Maximum retained bytes of one diagnostic stream. */
export const PI_DIAGNOSTIC_PREFIX_BYTES = 16 * 1024;
/** Maximum bytes of one encoded session handle. */
export const PI_SESSION_HANDLE_MAX_BYTES = 16 * 1024;
/** Failure reasons the host is allowed to report. Any other reason fails closed. */
export const PI_FAILED_REASONS = [
  'pi-codemode-unsupported',
  'pi-final-message-empty',
  'pi-identity-failed',
  'pi-output-malformed',
  'pi-output-too-large',
  'pi-prompt-failed',
  'pi-route-mismatch',
  'pi-setup-failed',
  'pi-terminal-correlation-failed',
] as const;
/** The only interruption reason that is a clean native interrupt. */
export const PI_INTERRUPT_REASON = 'worker-interrupted';
/** Closed error vocabulary emitted by the private host. */
export const PI_HOST_ERROR_CODES = [
  'invalid_request',
  'invalid_state',
  'identity_failed',
  'setup_failed',
  'busy',
] as const;

const KNOWN_EVENTS = new Set([
  'extension_error',
  'native',
  'native_omitted',
  'turn_settled',
  'ui_unsupported',
]);

/** One host response. Unknown result fields are ignored by the caller. */
export type PiHostResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: Readonly<Record<string, unknown>>;
    }
  | {
      readonly error: { readonly code: string; readonly message: string };
      readonly id: number | null;
      readonly ok: false;
    };

/** One parsed `turn_settled` event whose outcome is checked by the projection. */
export interface PiTurnSettledFrame {
  readonly compactionEntryIds: readonly string[];
  readonly nativeHandle: unknown;
  readonly outcome: unknown;
  readonly turnId: string;
}

/** A frame the adapter knows how to route. */
export type PiParsedFrame =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'native'; readonly turnId: string }
  | { readonly kind: 'response'; readonly response: PiHostResponse }
  | { readonly kind: 'settled'; readonly settled: PiTurnSettledFrame }
  | { readonly kind: 'ui'; readonly method: string; readonly turnId: string | null };

/**
 * Splits a host byte stream into bounded UTF-8 lines.
 *
 * @param onLine Receives each nonempty line.
 * @param onOverflow Receives the first oversized or undecodable line. Input until the next line
 *   feed is discarded.
 * @param maxBytes Maximum bytes of one line. Production uses {@link PI_CHANNEL_FRAME_MAX_BYTES}.
 * @returns A function that consumes one chunk.
 */
export function createPiLineReader(
  onLine: (line: string) => void,
  onOverflow: () => void,
  maxBytes = PI_CHANNEL_FRAME_MAX_BYTES
): (chunk: Buffer) => void {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  return (chunk) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!discarding && end > start) {
        const piece = Buffer.from(chunk.subarray(start, end));
        pendingBytes += piece.length;
        if (pendingBytes > maxBytes) {
          discarding = true;
          pending = [];
          pendingBytes = 0;
          onOverflow();
        } else {
          pending.push(piece);
        }
      }
      if (newline < 0) return;
      if (!discarding) {
        let line: string | null = null;
        try {
          line = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending));
        } catch {
          line = null;
        }
        if (line === null) onOverflow();
        else if (line.trim()) onLine(line);
      }
      pending = [];
      pendingBytes = 0;
      discarding = false;
      start = newline + 1;
    }
  };
}

/**
 * Parses one host frame.
 *
 * Unknown event names are ignored. A known frame whose relied-upon fields have an unknown shape
 * is `invalid`.
 *
 * @param line One UTF-8 JSON line without its trailing line feed.
 * @returns The classified frame.
 */
export function parsePiHostFrame(line: string): PiParsedFrame {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(value)) return { kind: 'invalid' };
  if ('event' in value) return parseEvent(value);
  if (value.ok === true) {
    if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 0) {
      return { kind: 'invalid' };
    }
    if (!isRecord(value.result)) return { kind: 'invalid' };
    return { kind: 'response', response: { id: value.id, ok: true, result: value.result } };
  }
  if (value.ok === false) {
    const id = value.id === null ? null : value.id;
    if (id !== null && (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)) {
      return { kind: 'invalid' };
    }
    if (
      !isRecord(value.error) ||
      typeof value.error.code !== 'string' ||
      !PI_HOST_ERROR_CODES.includes(value.error.code as never)
    ) {
      return { kind: 'invalid' };
    }
    const message = typeof value.error.message === 'string' ? value.error.message : '';
    return {
      kind: 'response',
      response: { error: { code: value.error.code, message }, id, ok: false },
    };
  }
  return { kind: 'invalid' };
}

/**
 * Removes exact secret values and common credential assignments from one diagnostic.
 *
 * @param text Diagnostic text.
 * @param secrets Exact values that must not appear. Empty strings are skipped.
 * @returns Redacted text.
 */
export function redactPiText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted
    .replace(/\bAuthorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]')
    .replace(/\b(token|secret|password|api[ _-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

/** Classifies one event object. */
function parseEvent(value: Readonly<Record<string, unknown>>): PiParsedFrame {
  const event = value.event;
  if (typeof event !== 'string') return { kind: 'invalid' };
  if (!KNOWN_EVENTS.has(event)) return { kind: 'ignored' };
  if (event === 'native_omitted') return { kind: 'ignored' };
  if (event === 'extension_error') {
    return typeof value.message === 'string' ? { kind: 'ignored' } : { kind: 'invalid' };
  }
  if (event === 'native') {
    return typeof value.turnId === 'string'
      ? { kind: 'native', turnId: value.turnId }
      : { kind: 'invalid' };
  }
  if (event === 'ui_unsupported') {
    if (typeof value.method !== 'string' || value.method.length === 0) return { kind: 'ignored' };
    const turnId = value.turnId === null ? null : value.turnId;
    if (turnId !== null && typeof turnId !== 'string') return { kind: 'ignored' };
    return { kind: 'ui', method: value.method, turnId };
  }
  if (typeof value.turnId !== 'string' || !Array.isArray(value.compactionEntryIds)) {
    return { kind: 'invalid' };
  }
  if (!value.compactionEntryIds.every((id) => typeof id === 'string')) return { kind: 'invalid' };
  if (!('nativeHandle' in value) || !('outcome' in value)) return { kind: 'invalid' };
  return {
    kind: 'settled',
    settled: {
      compactionEntryIds: value.compactionEntryIds,
      nativeHandle: value.nativeHandle,
      outcome: value.outcome,
      turnId: value.turnId,
    },
  };
}

/** Checks whether one JSON value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
