import { COMPOSER_TRANSCRIBE_MAX_AUDIO_BYTES } from '@openkit/app-api-schemas';
import { bindLocalSpeechAbort } from '../local-ai/supply.js';
import { OperationError } from '../operation-error.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { classifyPiAiFailure, type PiAiFailure } from './pi-ai-failure.js';

/** A contacted or uncontacted transcription attempt, with Gateway failure evidence. */
export class TranscriptionRequestError extends Error {
  readonly failure: PiAiFailure;
  readonly received: boolean;
  readonly seconds?: number;

  constructor(
    failure: PiAiFailure,
    options: { received: boolean; seconds?: number; cause?: unknown }
  ) {
    super('Transcription attempt failed.', { cause: options.cause });
    this.name = 'TranscriptionRequestError';
    this.failure = failure;
    this.received = options.received;
    if (options.seconds !== undefined) this.seconds = options.seconds;
  }
}

/** Fixed prompt. It discourages invented words when the clip is silence. */
export const TRANSCRIPTION_PROMPT = 'Transcribe only what the speaker says. Do not add words.';

const TRANSCRIPTION_RESPONSE_BYTES = 1_000_000;

/**
 * Decodes one base64 clip and enforces the audio byte cap without a duration probe.
 *
 * @param audio Base64 audio from the operation body.
 * @returns Decoded bytes. The caller must not retain them after the upstream call.
 * @throws OperationError when the encoding is invalid or the clip is over the cap.
 */
export function decodeTranscriptionAudio(audio: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audio) || audio.length % 4 !== 0) {
    throw new OperationError('invalid_request', 'Invalid transcription audio.', 400);
  }
  const padding = audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor((audio.length * 3) / 4) - padding;
  if (decodedBytes < 1 || decodedBytes > COMPOSER_TRANSCRIBE_MAX_AUDIO_BYTES) {
    throw new OperationError(
      'payload_too_large',
      'Transcription audio exceeds the size limit.',
      413
    );
  }
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.byteLength !== decodedBytes) {
    throw new OperationError('invalid_request', 'Invalid transcription audio.', 400);
  }
  return bytes;
}

/**
 * Builds the OpenAI-compatible transcription URL from an authored API root.
 *
 * @param baseUrl Provider base URL, including its `/v1` prefix when that is the API root.
 * @returns Absolute `/audio/transcriptions` URL.
 */
export function transcriptionRequestUrl(baseUrl: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('audio/transcriptions', root).toString();
}

/** Filename and media type for the multipart file part. */
function transcriptionFile(mimeType: 'audio/webm' | 'audio/webm;codecs=opus' | 'audio/mp4'): {
  filename: string;
  mediaType: string;
} {
  if (mimeType === 'audio/mp4') return { filename: 'clip.mp4', mediaType: 'audio/mp4' };
  return { filename: 'clip.webm', mediaType: 'audio/webm' };
}

/**
 * Posts one clip to the provider audio transcription endpoint.
 *
 * The platform encoder sets the multipart boundary. No temp file is created.
 *
 * @param input Resolved provider, clip, caller signal, and the fetch signal.
 * @returns Transcript text when the response is accepted. Reported seconds stay on a thrown failure when a response was received.
 * @throws TranscriptionRequestError carrying classified failure evidence. OperationError when the provider cannot be contacted for a local reason.
 */
export async function postAudioTranscription(input: {
  readonly provider: ResolvedLLMProviderConfig;
  readonly model: string;
  readonly audio: Buffer;
  readonly mimeType: 'audio/webm' | 'audio/webm;codecs=opus' | 'audio/mp4';
  readonly language?: string;
  readonly signal: AbortSignal;
  readonly callerSignal?: AbortSignal;
}): Promise<{ text: string; seconds?: number }> {
  if (!input.provider.baseUrl) {
    throw new OperationError(
      'provider_base_url_missing',
      'Transcription provider has no base URL.',
      409
    );
  }
  if (input.provider.requiresApiKey && !input.provider.apiKey) {
    throw new OperationError(
      'provider_api_key_missing',
      'Transcription provider credential is unavailable.',
      409
    );
  }
  const file = transcriptionFile(input.mimeType);
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(input.audio)], { type: file.mediaType }),
    file.filename
  );
  form.append('model', input.model);
  form.append('prompt', TRANSCRIPTION_PROMPT);
  if (input.language) form.append('language', input.language);
  const headers = new Headers();
  if (input.provider.apiKey) headers.set('authorization', `Bearer ${input.provider.apiKey}`);
  const disposeSpeechAbort = bindLocalSpeechAbort(input.provider.baseUrl, input.signal);
  try {
    let response: Response;
    try {
      response = await fetch(transcriptionRequestUrl(input.provider.baseUrl), {
        method: 'POST',
        headers,
        body: form,
        signal: input.signal,
      });
    } catch (error) {
      if (
        input.callerSignal?.aborted ||
        (input.signal.aborted && input.callerSignal === undefined)
      ) {
        throw new TranscriptionRequestError(
          { kind: 'cancelled', settled: false },
          { received: false, cause: error }
        );
      }
      if (input.signal.aborted) {
        throw new TranscriptionRequestError(
          { kind: 'provider_unavailable', settled: false },
          { received: false, cause: error }
        );
      }
      throw new TranscriptionRequestError(classifyTransportFailure(error), {
        received: false,
        cause: error,
      });
    }
    const retryAfter = response.headers.get('retry-after') ?? undefined;
    const payload = await readTranscriptionResponse(response).catch(() => null);
    const seconds = payload === null ? undefined : reportedSeconds(payload);
    const text = payload !== null && typeof payload.text === 'string' ? payload.text : undefined;
    if (!response.ok || text === undefined) {
      const failure = classifyPiAiFailure({
        ...(payload && typeof payload === 'object' ? payload : {}),
        status: response.status,
        headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
      }) ?? { kind: 'unknown' as const, settled: true, status: response.status };
      throw new TranscriptionRequestError(failure, {
        received: true,
        ...(seconds === undefined ? {} : { seconds }),
        cause: payload,
      });
    }
    return seconds === undefined ? { text } : { text, seconds };
  } finally {
    disposeSpeechAbort();
  }
}

/** Uses the existing classifier, including a fetch cause that carries the connect-refusal code. */
function classifyTransportFailure(error: unknown): PiAiFailure {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let fallback: PiAiFailure | undefined;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const failure = classifyPiAiFailure(current);
    if (failure?.settled) return failure;
    fallback ??= failure;
    current = current instanceof Error ? current.cause : undefined;
  }
  return fallback ?? { kind: 'provider_unavailable', settled: false };
}

/** Reads a bounded response and drops the bytes when they are not JSON. */
async function readTranscriptionResponse(response: Response): Promise<{
  text?: unknown;
  duration?: unknown;
  usage?: { seconds?: unknown };
} | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > TRANSCRIPTION_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      text?: unknown;
      duration?: unknown;
      usage?: { seconds?: unknown };
    };
  } catch {
    return null;
  }
}

/** Prefers provider usage seconds, then a top-level duration. */
function reportedSeconds(payload: {
  duration?: unknown;
  usage?: { seconds?: unknown };
}): number | undefined {
  const usageSeconds = payload.usage?.seconds;
  const value = typeof usageSeconds === 'number' ? usageSeconds : payload.duration;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
