import type {
  ModelRequestJson,
  ModelTokenCounter,
  ModelTokenCountInput,
  ModelTokenCountUnavailable,
  TokenModelIdentity,
} from './model-token-admission.js';

/** Already resolved physical route and credential, shared with the actual inference dispatch. */
export interface ResponsesTokenCounterOptions {
  readonly model: TokenModelIdentity;
  /** Actual selected model base URL, including its existing API prefix; no default route is inferred. */
  readonly baseUrl: string;
  /** Exact selected API credential, or null for an explicitly credential-free provider. */
  readonly apiKey: string | null;
  /** Existing selected transport when supplied; it must honor AbortSignal and must not retry. */
  readonly fetch?: typeof fetch;
}

const REQUEST_BYTES = 16 * 1024 * 1024;
const RESPONSE_BYTES = 8192;
const TIMEOUT_MS = 10_000;
const ACCOUNTING_IDENTITY = 'responses-input-tokens/openai-sdk-7.19.0/v1';

// Exact InputTokenCountParams keys in the pinned openai 7.19.0
// resources/responses/input-tokens.d.ts. Preserve nested values in full: local
// schema filtering must not erase instructions, history, media or Tool context.
const COUNT_FIELDS = new Set([
  'conversation', 'input', 'instructions', 'model', 'parallel_tool_calls',
  'personality', 'previous_response_id', 'reasoning', 'text', 'tool_choice',
  'tools', 'truncation',
]);

// ResponseCreateParamsBase in the same SDK classifies these as response delivery,
// generated-output controls, stored-object annotations, cache affinity/retention,
// abuse attribution, or execution service tier. They are not input context and
// are absent from InputTokenCountParams. In particular max_output_tokens is
// separately checked against the independent admission reserve. Unknown keys
// (including prompt, context_management and additional_tools) refuse below.
const NON_CONTEXT_FIELDS = new Set([
  'background', 'include', 'max_output_tokens', 'metadata', 'prompt_cache_key',
  'prompt_cache_retention', 'safety_identifier', 'service_tier', 'store', 'stream',
  'stream_options', 'temperature', 'top_logprobs', 'top_p', 'user',
]);

/** Fixed unavailable result; no request, credential or upstream error text escapes. */
function unavailable(reason: ModelTokenCountUnavailable['reason'] = 'counter-unavailable'): ModelTokenCountUnavailable {
  return { kind: 'unavailable', reason };
}

/** Constructs only the selected provider's fixed non-inference counter path. */
function counterEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses/input_tokens`;
    return url.href;
  } catch { return null; }
}

/** Projects only the SDK's represented count fields; unsupported semantics never disappear. */
function countBody(input: ModelTokenCountInput): Record<string, ModelRequestJson> | null {
  if (!Object.isFrozen(input) || !Object.isFrozen(input.request)) return null;
  const body: Record<string, ModelRequestJson> = Object.create(null);
  for (const [key, value] of Object.entries(input.request)) {
    if (COUNT_FIELDS.has(key)) body[key] = value;
    else if (!NON_CONTEXT_FIELDS.has(key)) return null;
  }
  return body;
}

/**
 * Creates a route-owned non-inference counter for plain Responses only.
 *
 * Invoke it through admitModelRequest, whose bounded immutable JSON capture owns
 * pre-allocation validation. The represented body is a subset of that capture;
 * its wire bytes are checked again here. This adapter owns no inference route,
 * credential lookup, retry or cache. A selected provider must actually implement
 * the documented endpoint before its operational coverage can be claimed.
 * Chat, Codex and opaque context outside the represented body remain unqualified.
 * Protocol evidence: openai 7.19.0 resources/responses/input-tokens.{js,d.ts} and
 * https://developers.openai.com/api/docs/guides/token-counting.
 */
export function createResponsesTokenCounter(options: ResponsesTokenCounterOptions): ModelTokenCounter {
  const model = Object.freeze({ ...options.model });
  const endpoint = counterEndpoint(options.baseUrl);
  const apiKey = options.apiKey;
  const fetchRequest = options.fetch ?? globalThis.fetch;
  return async (input, signal) => {
    const deadlineAt = Date.now() + TIMEOUT_MS;
    if (signal?.aborted) return unavailable('cancelled');
    if (model.api !== 'responses' || input.model.api !== 'responses') return unavailable('api-unqualified');
    if (model.providerId !== input.model.providerId || model.modelId !== input.model.modelId || input.request.model !== model.modelId) return unavailable('model-unqualified');
    // The SDK describes server-side conversation references, but this first
    // subset does not prove their immutable history between count and dispatch.
    if (input.continuity !== null || input.request.conversation != null || input.request.previous_response_id != null) return unavailable('continuity-unqualified');
    if (input.request.truncation !== undefined && input.request.truncation !== 'disabled') return unavailable('api-unqualified');
    if (!endpoint || (apiKey !== null && (typeof apiKey !== 'string' || apiKey.length === 0))) return unavailable();
    const body = countBody(input);
    if (!body) return unavailable('api-unqualified');
    // The parent capture has already proved the allocation bound. This subset
    // cannot grow it; no second unbounded serialization admission is introduced.
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > REQUEST_BYTES) return unavailable();
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return unavailable();
    const abort = new AbortController();
    let rejectDeadline!: (reason: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const onAbort = () => { abort.abort(); rejectDeadline(new Error('Counter cancelled.')); };
    const timeout = setTimeout(() => { abort.abort(); rejectDeadline(new Error('Counter deadline.')); }, remainingMs);
    timeout.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (signal?.aborted) return unavailable('cancelled');
      response = await Promise.race([fetchRequest(endpoint, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: abort.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity',
          ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }) }, body: serialized,
      }), deadline]);
      const encoding = response.headers.get('content-encoding');
      const length = response.headers.get('content-length');
      if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || (encoding && encoding.toLowerCase() !== 'identity')
        || (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > RESPONSE_BYTES))
        || !response.body) return unavailable();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let byteLength = 0;
      while (true) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > RESPONSE_BYTES) return unavailable();
        chunks.push(value);
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
      const result = value as Record<string, unknown>;
      if (result.object !== 'response.input_tokens' || typeof result.input_tokens !== 'number'
        || !Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0) return unavailable();
      if (signal?.aborted) return unavailable('cancelled');
      return { kind: 'counted', model, requestDigest: input.requestDigest,
        imageFactsDigest: input.imageFactsDigest, accountingIdentity: ACCOUNTING_IDENTITY,
        coverage: 'complete-request', inputTokens: result.input_tokens };
    } catch { return unavailable(signal?.aborted ? 'cancelled' : 'counter-unavailable'); }
    finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', onAbort);
      // Abort reaches real fetch and any active body read. Do not await a remote
      // peer's close acknowledgement beyond the already fixed local deadline.
      abort.abort();
      if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      else if (response?.body) void response.body.cancel().catch(() => undefined);
    }
  };
}
