import { type ReasoningEffort, ReasoningEffortSchema } from '@openkit/protocol';
import { z } from 'zod';
import { PI_SESSION_HANDLE_MAX_BYTES } from './identity.ts';
import { PI_RESULT_CONTENT_MAX_BYTES, type PiTurnOutcome } from './outcome.ts';

/**
 * Private control channel between the supervising Harness and one Pi runtime host.
 *
 * Frames are UTF-8 JSON objects, one per line, on the host's file descriptor 3, which the
 * Harness creates as a private socket pair. User Extensions run in the host and may write to
 * stdout or stderr; neither carries a frame. Each request carries an `id` that its single
 * response echoes. The host also sends unsolicited events. This is not a product protocol.
 */

/** Maximum bytes of one inbound request line. */
export const CHANNEL_REQUEST_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Maximum bytes of one outbound frame: the final text, which the content bound also bounds, under
 * worst-case JSON escaping.
 */
export const CHANNEL_FRAME_MAX_BYTES = 6 * PI_RESULT_CONTENT_MAX_BYTES + 64 * 1024;
/** Maximum bytes of one forwarded native session event; larger events are reported as omitted. */
export const CHANNEL_NATIVE_EVENT_MAX_BYTES = 4 * 1024 * 1024;
/** Maximum bytes of one Turn prompt. */
export const PI_PROMPT_MAX_BYTES = 4 * 1024 * 1024;

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') && !value.includes('\0'), 'absolute path');
const loopbackUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username;
    } catch {
      return false;
    }
  }, 'loopback http URL');
const loopbackCredential = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const requestId = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const turnId = z.string().min(1).max(256);

/** The admitted logical model the host projects through the inference loopback. */
export const PiModelDescriptorSchema = z
  .strictObject({
    contextWindow: z.int().positive(),
    inputModalities: z.array(z.enum(['text', 'image'])).min(1),
    maxOutputTokens: z.int().positive(),
    modelId: z.string().min(1).max(256),
    reasoning: z.boolean(),
    reasoningEffortLevels: ReasoningEffortSchema.array().optional(),
  })
  .refine(
    (value) =>
      value.maxOutputTokens <= value.contextWindow &&
      value.inputModalities.includes('text') &&
      new Set(value.inputModalities).size === value.inputModalities.length,
    'model parameters'
  );

/** One Harness-to-host request. */
export const HostRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({
    agentDir: absolutePath,
    capabilityBaseUrl: loopbackUrl,
    capabilityCredential: loopbackCredential,
    id: requestId,
    inferenceBaseUrl: loopbackUrl,
    inferenceCredential: loopbackCredential,
    mcpServers: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))
      .max(64)
      .refine((value) => new Set(value).size === value.length, 'unique server ids'),
    model: PiModelDescriptorSchema,
    op: z.literal('open'),
    resume: z
      .strictObject({
        handle: z
          .string()
          .min(1)
          .refine((value) => Buffer.byteLength(value, 'utf8') <= PI_SESSION_HANDLE_MAX_BYTES),
      })
      .nullable(),
    skillTargetPaths: z.array(absolutePath),
    stateRoot: absolutePath,
    workingDirectory: absolutePath,
  }),
  z.strictObject({ id: requestId, op: z.literal('inspect') }),
  z.strictObject({ id: requestId, model: PiModelDescriptorSchema, op: z.literal('configure') }),
  z.strictObject({
    id: requestId,
    op: z.literal('turn'),
    reasoningEffort: ReasoningEffortSchema.optional(),
    prompt: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= PI_PROMPT_MAX_BYTES),
    turnId,
  }),
  z.strictObject({ id: requestId, op: z.literal('interrupt'), turnId }),
  z.strictObject({ id: requestId, op: z.literal('close') }),
]);

/** Parsed Harness request. */
export type HostRequest = z.infer<typeof HostRequestSchema>;
/** Parsed `open` request. */
export type HostOpenRequest = Extract<HostRequest, { op: 'open' }>;
/** Admitted model descriptor. */
export type PiModelDescriptor = z.infer<typeof PiModelDescriptorSchema>;

/** Closed set of request failure codes. */
export type HostErrorCode =
  | 'invalid_request'
  | 'invalid_state'
  | 'identity_failed'
  | 'setup_failed'
  | 'busy';

/** The native handle state the host reports for the bound conversation. */
export type HostNativeHandle =
  | { readonly state: 'pending' }
  | { readonly digest: string; readonly handle: string; readonly state: 'ready' }
  | { readonly state: 'unknown' };

/** One host-to-Harness response. */
export type HostResponse =
  | { readonly id: number; readonly ok: true; readonly result: Record<string, unknown> }
  | {
      readonly error: { readonly code: HostErrorCode; readonly message: string };
      readonly id: number | null;
      readonly ok: false;
    };

/** One unsolicited host-to-Harness event. */
export type HostEvent =
  | { readonly data: unknown; readonly event: 'native'; readonly turnId: string }
  | {
      readonly bytes: number;
      readonly event: 'native_omitted';
      readonly turnId: string;
      readonly type: string;
    }
  | { readonly event: 'ui_unsupported'; readonly method: string; readonly turnId: string | null }
  | { readonly event: 'extension_error'; readonly message: string }
  | {
      readonly compactionEntryIds: readonly string[];
      readonly event: 'turn_settled';
      /** Effective native selection after prompt settlement; unknown if it is outside Core. */
      readonly reasoningEffort: ReasoningEffort | 'unknown';
      readonly nativeHandle: HostNativeHandle;
      readonly outcome: PiTurnOutcome;
      readonly turnId: string;
    };

/**
 * Splits an inbound byte stream into bounded JSON lines.
 *
 * @param onLine Receives each complete line as text.
 * @param onOverflow Receives the first line that exceeds {@link CHANNEL_REQUEST_MAX_BYTES}; the
 *   reader then discards input until the next line feed.
 * @returns A function that consumes one chunk.
 */
export function createLineReader(
  onLine: (line: string) => void,
  onOverflow: () => void
): (chunk: Buffer) => void {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return (chunk) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      if (!discarding) {
        pendingBytes += piece.length;
        if (pendingBytes > CHANNEL_REQUEST_MAX_BYTES) {
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
        const bytes = Buffer.concat(pending);
        let line: string | null;
        try {
          line = decoder.decode(bytes);
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
 * Serializes one outbound frame, replacing any occurrence of a secret with a fixed marker.
 *
 * @param frame Response or event.
 * @param secrets Raw values that must never leave the host, such as the loopback credentials.
 * @returns The frame line with its trailing line feed.
 * @throws Error when the serialized frame exceeds {@link CHANNEL_FRAME_MAX_BYTES}.
 */
export function encodeFrame(frame: HostResponse | HostEvent, secrets: readonly string[]): string {
  let text = JSON.stringify(frame);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  if (Buffer.byteLength(text, 'utf8') > CHANNEL_FRAME_MAX_BYTES) {
    throw new Error('Pi host frame exceeds its bound.');
  }
  return `${text}\n`;
}
