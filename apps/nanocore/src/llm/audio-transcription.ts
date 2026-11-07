import { COMPOSER_TRANSCRIBE_MAX_AUDIO_BYTES } from '@openkit/app-api-schemas';
import { OperationError } from '../operation-error.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';

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
 * @param input Resolved provider, clip, and optional language tag.
 * @returns Transcript text only when the response is accepted. Reported seconds are returned for any received response that states a valid measurement, including a rejected response. The raw body is not returned.
 * @throws OperationError when the provider is not contacted. A received rejection is returned so the caller can record usage before its fixed public failure.
 */
export async function postAudioTranscription(input: {
  readonly provider: ResolvedLLMProviderConfig;
  readonly model: string;
  readonly audio: Buffer;
  readonly mimeType: 'audio/webm' | 'audio/webm;codecs=opus' | 'audio/mp4';
  readonly language?: string;
  readonly signal: AbortSignal;
}): Promise<{ text?: string; seconds?: number }> {
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
  let response: Response;
  try {
    response = await fetch(transcriptionRequestUrl(input.provider.baseUrl), {
      method: 'POST',
      headers,
      body: form,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) {
      throw new OperationError('transcription_aborted', 'Transcription was cancelled.', 400, {
        cause: error,
      });
    }
    throw new OperationError('transcription_failed', 'Transcription failed.', 502, {
      cause: error,
    });
  }
  const payload = await readTranscriptionResponse(response).catch(() => null);
  const seconds = payload === null ? undefined : reportedSeconds(payload);
  const text =
    response.ok && payload !== null && typeof payload.text === 'string' ? payload.text : undefined;
  if (text === undefined) return seconds === undefined ? {} : { seconds };
  return seconds === undefined ? { text } : { text, seconds };
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
