import { createHash } from 'node:crypto';

/** JSON captured after provider mapping; strings retain their exact Unicode spelling. */
export type ModelRequestJson =
  | null
  | boolean
  | number
  | string
  | readonly ModelRequestJson[]
  | {
      readonly [key: string]: ModelRequestJson;
    };

/** Actual selected route, rather than a logical model or an inferred tokenizer family. */
export interface TokenModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly api: 'responses' | 'chat-completions' | 'codex-responses';
}

/** Trusted processor facts for one exact inline image block, located by JSON Pointer. */
export interface ModelImageFacts {
  readonly path: string;
  readonly contentDigest: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly frames: 1;
  readonly detail: 'auto' | 'low' | 'high' | 'original';
}

/** Immutable complete counter input. Opaque native state must be supplied here too. */
export interface ModelTokenCountInput {
  readonly model: TokenModelIdentity;
  readonly request: { readonly [key: string]: ModelRequestJson };
  readonly imageFacts: readonly ModelImageFacts[];
  readonly continuity: ModelRequestJson;
  readonly requestDigest: string;
  readonly imageFactsDigest: string;
}

/** Exact provider count or a documented conservative complete-request upper bound. */
export interface ModelTokenCountReceipt {
  readonly kind: 'counted';
  readonly model: TokenModelIdentity;
  readonly requestDigest: string;
  readonly accountingIdentity: string;
  readonly inputTokens: number;
  /** Included in inputTokens; never added a second time. */
  readonly imageTokens: number;
  readonly imageFactsDigest: string;
  /** Must include all instructions, history, tools, media and supplied native state. */
  readonly coverage: 'complete-request';
}

/** Closed public failures; counter errors and request content never become diagnostics. */
export type ModelTokenUnavailableReason =
  | 'invalid-request'
  | 'capture-limit'
  | 'counter-unavailable'
  | 'model-unqualified'
  | 'api-unqualified'
  | 'continuity-unqualified'
  | 'media-unqualified'
  | 'invalid-count-receipt'
  | 'cancelled';

/** Qualified counter refusal, with no raw upstream error or body. */
export interface ModelTokenCountUnavailable {
  readonly kind: 'unavailable';
  readonly reason: ModelTokenUnavailableReason;
}

/**
 * Trusted route-owned counting capability, not an untrusted request field.
 *
 * Its owner must prove complete accounting for this physical model, API, media and
 * native continuity. A callback's existence alone qualifies no route. OpenAI's
 * Responses count endpoint must not be reused for Chat or opaque Codex state
 * without that proof. See https://developers.openai.com/api/docs/guides/token-counting.
 * The transport owner must stop its own I/O on cancellation; admission can only
 * stop waiting and refuse dispatch. It cannot stop an injected external effect.
 */
export type ModelTokenCounter = (
  input: ModelTokenCountInput,
  signal?: AbortSignal
) => Promise<ModelTokenCountReceipt | ModelTokenCountUnavailable>;

/** Independent model limits and caller-owned cancellation for one final request. */
export interface ModelTokenAdmissionInput {
  readonly model: TokenModelIdentity;
  readonly request: unknown;
  readonly imageFacts: readonly ModelImageFacts[];
  /** Exact extra provider context, such as Codex turn state; absent means none. */
  readonly continuity?: ModelRequestJson;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  /** Reserved independently of the counter and at least every wire output limit. */
  readonly outputReserveTokens: number;
  readonly counter?: ModelTokenCounter;
  readonly signal?: AbortSignal;
}

/** Successful accounting evidence; dispatch must use this exact frozen request and state. */
export interface ModelTokenAdmission extends ModelTokenCountInput {
  readonly kind: 'admitted';
  readonly accountingIdentity: string;
  readonly inputTokens: number;
  readonly imageTokens: number;
  readonly outputReserveTokens: number;
  readonly totalTokens: number;
}

/** Admission outcome, separate from independent transport and byte admission. */
export type ModelTokenAdmissionResult =
  | ModelTokenAdmission
  | ModelTokenCountUnavailable
  | {
      readonly kind: 'refused';
      readonly reason: 'output-limit-exceeded' | 'context-limit-exceeded';
    };

// This capture ceiling follows the existing Worker inference body limit. It is
// a memory/serialization guard, never a token estimate. No tokenizer is guessed.
const CAPTURE_BYTES = 16 * 1024 * 1024;
const CAPTURE_NODES = 100_000;
const CAPTURE_DEPTH = 64;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COUNTER_REASONS = new Set<ModelTokenUnavailableReason>([
  'counter-unavailable',
  'model-unqualified',
  'api-unqualified',
  'continuity-unqualified',
  'media-unqualified',
  'cancelled',
]);

/** Internal bounded refusal, without retained source content. */
class AdmissionFailure extends Error {
  constructor(readonly reason: ModelTokenUnavailableReason) {
    super(reason);
  }
}

/** Canonical strict JSON snapshot; no accessors, toJSON hooks, normalization or mutation. */
function capture(value: unknown): { value: ModelRequestJson; json: string } {
  let bytes = 0;
  let nodes = 0;
  const parts: string[] = [];
  const append = (part: string) => {
    bytes += Buffer.byteLength(part);
    if (bytes > CAPTURE_BYTES) throw new AdmissionFailure('capture-limit');
    parts.push(part);
  };
  const string = (text: string) => {
    // Forecast escapes before JSON.stringify can allocate an expanded string.
    let size = 2;
    for (const char of text) {
      const code = char.codePointAt(0)!;
      size +=
        code < 32
          ? [8, 9, 10, 12, 13].includes(code)
            ? 2
            : 6
          : char === '"' || char === '\\'
            ? 2
            : code >= 0xd800 && code <= 0xdfff
              ? 6
              : Buffer.byteLength(char);
      if (size + bytes > CAPTURE_BYTES) throw new AdmissionFailure('capture-limit');
    }
    append(JSON.stringify(text));
  };
  const walk = (item: unknown, depth: number): ModelRequestJson => {
    if (++nodes > CAPTURE_NODES || depth > CAPTURE_DEPTH)
      throw new AdmissionFailure('capture-limit');
    if (typeof item === 'string') {
      string(item);
      return item;
    }
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      append(JSON.stringify(item));
      return item;
    }
    if (typeof item !== 'object' || item === null) throw new AdmissionFailure('invalid-request');
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      throw new AdmissionFailure('invalid-request');
    }
    if (Object.getOwnPropertySymbols(item).length) throw new AdmissionFailure('invalid-request');
    const keys = Object.keys(item);
    if (array && (keys.length !== item.length || keys.some((key, i) => key !== String(i)))) {
      throw new AdmissionFailure('invalid-request');
    }
    const result: ModelRequestJson[] | Record<string, ModelRequestJson> = array
      ? []
      : Object.create(null);
    append(array ? '[' : '{');
    let index = 0;
    for (const key of array ? keys : keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        throw new AdmissionFailure('invalid-request');
      if (index++) append(',');
      if (!array) {
        string(key);
        append(':');
      }
      const child = walk(descriptor.value, depth + 1);
      if (Array.isArray(result)) result.push(child);
      else Object.defineProperty(result, key, { value: child, enumerable: true });
    }
    append(array ? ']' : '}');
    return Object.freeze(result);
  };
  return { value: walk(value, 0), json: parts.join('') };
}

/** SHA over exact canonical request evidence; no Unicode normalization. */
function digest(json: string): string {
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

/** Narrows captured JSON objects without coercion. */
function record(value: ModelRequestJson | undefined): Record<string, ModelRequestJson> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, ModelRequestJson>)
    : null;
}

/** Safe integral token/size value, including zero where the owner permits it. */
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validates only actual content blocks, never strings or Tool schema property names. */
function assertImages(input: ModelTokenCountInput): void {
  const found = new Set<string>();
  const facts = new Map(input.imageFacts.map((fact) => [fact.path, fact]));
  if (facts.size !== input.imageFacts.length) throw new AdmissionFailure('media-unqualified');
  const blocks = (value: ModelRequestJson | undefined, path: string) => {
    if (!Array.isArray(value)) return;
    for (let i = 0; i < value.length; i++) {
      const block = record(value[i]);
      if (!block) throw new AdmissionFailure('media-unqualified');
      if (['text', 'input_text', 'output_text', 'refusal'].includes(String(block.type))) continue;
      if (block.type !== 'image_url' && block.type !== 'input_image')
        throw new AdmissionFailure('media-unqualified');
      const image = block.type === 'image_url' ? record(block.image_url) : block;
      const url = block.type === 'image_url' ? image?.url : block.image_url;
      const detail = image?.detail ?? 'auto';
      const pointer = `${path}/${i}`;
      const fact = facts.get(pointer);
      if (
        !fact ||
        !DIGEST.test(fact.contentDigest) ||
        !count(fact.byteLength) ||
        fact.byteLength === 0 ||
        !count(fact.width) ||
        fact.width === 0 ||
        !count(fact.height) ||
        fact.height === 0 ||
        !count(fact.width * fact.height) ||
        fact.frames !== 1 ||
        fact.detail !== detail ||
        !['auto', 'low', 'high', 'original'].includes(fact.detail) ||
        typeof url !== 'string'
      ) {
        throw new AdmissionFailure('media-unqualified');
      }
      // Mutable URL/file references cannot attest exact dimensions or original SHA.
      const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if (!match) throw new AdmissionFailure('media-unqualified');
      const body = Buffer.from(match[1]!, 'base64');
      if (
        body.toString('base64') !== match[1] ||
        body.byteLength !== fact.byteLength ||
        digestBytes(body) !== fact.contentDigest
      )
        throw new AdmissionFailure('media-unqualified');
      found.add(pointer);
    }
  };
  const messages =
    input.model.api === 'chat-completions' ? input.request.messages : input.request.input;
  if (Array.isArray(messages)) {
    const root = input.model.api === 'chat-completions' ? '/messages' : '/input';
    for (let i = 0; i < messages.length; i++) {
      const message = record(messages[i]);
      if (!message) throw new AdmissionFailure('invalid-request');
      if (message.audio != null) throw new AdmissionFailure('media-unqualified');
      if (typeof message.role === 'string' || message.type === 'message') {
        if (
          message.content != null &&
          typeof message.content !== 'string' &&
          !Array.isArray(message.content)
        )
          throw new AdmissionFailure('media-unqualified');
        blocks(message.content, `${root}/${i}/content`);
      } else if (
        ![
          'function_call',
          'function_call_output',
          'custom_tool_call',
          'custom_tool_call_output',
          'reasoning',
          'compaction',
          'tool_search_call',
          'tool_search_output',
        ].includes(String(message.type))
      ) {
        throw new AdmissionFailure('api-unqualified');
      }
      if (message.type === 'function_call_output' || message.type === 'custom_tool_call_output')
        blocks(message.output, `${root}/${i}/output`);
    }
  }
  if (found.size !== facts.size) throw new AdmissionFailure('media-unqualified');
}

/** Hashes the exact delivered inline derivative bytes, independently of source metadata. */
function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Admits one exact final request with qualified model-specific token evidence.
 *
 * The caller owns current route qualification, complete actual request assembly,
 * media processor provenance and any provider counter transport. No default
 * OpenAI, Codex or DeepSeek route is qualified by this helper. Counter failures
 * never fall back to bytes/4, generic padding or a different model/API. Dispatch
 * must use the returned frozen request/state; rebuilding it invalidates admission.
 */
export async function admitModelRequest(
  input: ModelTokenAdmissionInput
): Promise<ModelTokenAdmissionResult> {
  try {
    const { contextWindowTokens, maxOutputTokens, outputReserveTokens, counter, signal } = input;
    if (signal?.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    const evidence = capture({
      model: input.model,
      request: input.request,
      imageFacts: input.imageFacts,
      continuity: input.continuity ?? null,
    });
    const captured = evidence.value as unknown as Omit<
      ModelTokenCountInput,
      'requestDigest' | 'imageFactsDigest'
    >;
    const model = captured.model;
    const request = record(captured.request);
    if (model?.api === 'codex-responses' && !Object.hasOwn(input, 'continuity')) {
      return { kind: 'unavailable', reason: 'continuity-unqualified' };
    }
    if (
      !model ||
      !['responses', 'chat-completions', 'codex-responses'].includes(model.api) ||
      ![model.providerId, model.modelId].every(
        (s) => typeof s === 'string' && s.length > 0 && s.length <= 256
      ) ||
      !request ||
      request.model !== model.modelId ||
      !count(contextWindowTokens) ||
      contextWindowTokens === 0 ||
      !count(maxOutputTokens) ||
      maxOutputTokens === 0 ||
      !count(outputReserveTokens) ||
      outputReserveTokens === 0 ||
      (model.api === 'chat-completions'
        ? !Array.isArray(request.messages)
        : typeof request.input !== 'string' && !Array.isArray(request.input))
    ) {
      throw new AdmissionFailure('invalid-request');
    }
    if (outputReserveTokens > maxOutputTokens)
      return { kind: 'refused', reason: 'output-limit-exceeded' };
    const fields =
      model.api === 'chat-completions'
        ? ['max_completion_tokens', 'max_tokens']
        : ['max_output_tokens'];
    const allFields = ['max_completion_tokens', 'max_tokens', 'max_output_tokens'];
    const supplied = allFields.filter((field) => Object.hasOwn(request, field));
    if (
      !supplied.length ||
      supplied.some(
        (field) => !fields.includes(field) || !count(request[field]) || request[field] === 0
      ) ||
      new Set(supplied.map((field) => request[field])).size > 1
    )
      throw new AdmissionFailure('invalid-request');
    if (supplied.some((field) => (request[field] as number) > outputReserveTokens))
      return { kind: 'refused', reason: 'output-limit-exceeded' };
    const countInput: ModelTokenCountInput = Object.freeze({
      ...captured,
      requestDigest: digest(evidence.json),
      imageFactsDigest: digest(capture(captured.imageFacts).json),
    });
    assertImages(countInput);
    if (!counter) return { kind: 'unavailable', reason: 'counter-unavailable' };
    let receipt: ModelTokenCountReceipt | ModelTokenCountUnavailable;
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<ModelTokenCountUnavailable>((resolve) => {
        onAbort = () => resolve({ kind: 'unavailable', reason: 'cancelled' });
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (signal?.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      receipt = await Promise.race([counter(countInput, signal), cancelled]);
    } catch {
      return { kind: 'unavailable', reason: signal?.aborted ? 'cancelled' : 'counter-unavailable' };
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    if (receipt?.kind === 'unavailable' && COUNTER_REASONS.has(receipt.reason))
      return { kind: 'unavailable', reason: receipt.reason };
    if (
      receipt?.kind !== 'counted' ||
      receipt.coverage !== 'complete-request' ||
      !receipt.model ||
      receipt.model.api !== model.api ||
      receipt.model.modelId !== model.modelId ||
      receipt.model.providerId !== model.providerId ||
      receipt.requestDigest !== countInput.requestDigest ||
      !count(receipt.inputTokens) ||
      !count(receipt.imageTokens) ||
      receipt.imageTokens > receipt.inputTokens ||
      (captured.imageFacts.length > 0 ? receipt.imageTokens === 0 : receipt.imageTokens !== 0) ||
      receipt.imageFactsDigest !== countInput.imageFactsDigest ||
      typeof receipt.accountingIdentity !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(receipt.accountingIdentity)
    ) {
      return { kind: 'unavailable', reason: 'invalid-count-receipt' };
    }
    if (receipt.inputTokens > contextWindowTokens - outputReserveTokens)
      return { kind: 'refused', reason: 'context-limit-exceeded' };
    return Object.freeze({
      ...countInput,
      kind: 'admitted',
      accountingIdentity: receipt.accountingIdentity,
      inputTokens: receipt.inputTokens,
      imageTokens: receipt.imageTokens,
      outputReserveTokens,
      totalTokens: receipt.inputTokens + outputReserveTokens,
    });
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof AdmissionFailure ? error.reason : 'invalid-request',
    };
  }
}
