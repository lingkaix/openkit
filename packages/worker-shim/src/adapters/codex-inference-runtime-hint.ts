import type { WorkerInferenceRuntimeHintMapping } from '../adapter-registry.js';

/** Pinned Codex sub-agent classifications retained without adapter-private labels. */
type CodexInferenceSubagentKind =
  | 'review'
  | 'compact'
  | 'thread_spawn'
  | 'memory_consolidation'
  | 'other';

/** Maximum accepted length for one runtime-native hint value. */
const MAX_RUNTIME_HINT_LENGTH = 16 * 1024;
/** Canonical Codex metadata key transported in the Responses request body. */
const CODEX_TURN_METADATA_KEY = 'x-codex-turn-metadata';

/**
 * Reads and cross-checks the pinned Codex 0.160.0 Responses metadata and its native projections.
 *
 * The returned object is intentionally ephemeral.
 * Callers must consume it before shared provider dispatch and must not persist it or forward its raw values upstream.
 *
 * @param headers Native worker request headers before the Integration relay.
 * @param request Parsed OpenAI-compatible request body.
 * @returns A normalized hint when canonical Codex metadata is present.
 * @throws Error when canonical metadata or a compatibility projection is invalid.
 */
function readCodexInferenceRuntimeHint(
  headers: Headers,
  request: Record<string, unknown>
): Readonly<Record<string, unknown>> | undefined {
  const clientMetadata = request.client_metadata;
  const hasCanonicalValue =
    isRecord(clientMetadata) && Object.hasOwn(clientMetadata, CODEX_TURN_METADATA_KEY);

  if (!hasCanonicalValue) {
    if (headers.has(CODEX_TURN_METADATA_KEY)) {
      throw invalidRuntimeHint();
    }
    return undefined;
  }
  if (!isStringRecord(clientMetadata)) {
    throw invalidRuntimeHint();
  }

  const canonical = readBoundedString(clientMetadata[CODEX_TURN_METADATA_KEY]);
  if (headers.get(CODEX_TURN_METADATA_KEY) !== canonical) {
    throw invalidRuntimeHint();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical) as unknown;
  } catch {
    throw invalidRuntimeHint();
  }
  if (!isRecord(parsed)) {
    throw invalidRuntimeHint();
  }

  const nativeSessionId = readBoundedString(parsed.session_id);
  const nativeThreadId = readBoundedString(parsed.thread_id);
  const nativeTurnId = readOptionalBoundedString(parsed.turn_id);
  const parentNativeThreadId = readOptionalBoundedString(parsed.parent_thread_id);
  requireWorkerResponsesRequestKind(parsed.request_kind);
  const canonicalSubagentKind = readSubagentKind(parsed.subagent_kind);

  requireProjection(clientMetadata.session_id, nativeSessionId);
  requireProjection(clientMetadata.thread_id, nativeThreadId);
  requireOptionalProjection(clientMetadata.turn_id, nativeTurnId);
  requireProjection(headers.get('session-id'), nativeSessionId);
  requireProjection(headers.get('thread-id'), nativeThreadId);
  requireProjection(headers.get('x-client-request-id'), nativeThreadId);
  requireOptionalProjection(clientMetadata['x-codex-parent-thread-id'], parentNativeThreadId);
  requireOptionalProjection(headers.get('x-codex-parent-thread-id'), parentNativeThreadId);
  const subagentKind = validateSubagentProjection(
    canonicalSubagentKind,
    clientMetadata['x-openai-subagent'],
    headers.get('x-openai-subagent')
  );

  const nativeCacheLineageId = Object.hasOwn(request, 'prompt_cache_key')
    ? readBoundedString(request.prompt_cache_key)
    : undefined;

  return {
    ...(nativeCacheLineageId ? { nativeCacheLineageId } : {}),
    nativeSessionId,
    nativeThreadId,
    ...(nativeTurnId ? { nativeTurnId } : {}),
    ...(parentNativeThreadId ? { parentNativeThreadId } : {}),
    runtimeFamily: 'codex',
    ...(subagentKind ? { subagentKind } : {}),
  };
}

/**
 * Requires one request kind emitted by the pinned Codex Responses worker path.
 *
 * @param value Canonical request kind.
 * @throws Error when the request cannot belong to the supported worker Responses path.
 */
function requireWorkerResponsesRequestKind(value: unknown): void {
  if (value !== 'turn' && value !== 'prewarm' && value !== 'compaction') {
    throw invalidRuntimeHint();
  }
}

/**
 * Checks whether an unknown value is a plain string-keyed record.
 *
 * @param value Candidate object.
 * @returns True when the value is a non-array object with only string values.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((candidate) => typeof candidate === 'string')
  );
}

/**
 * Checks whether an unknown value is a non-array object.
 *
 * @param value Candidate object.
 * @returns True when record access is safe.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Reads one non-empty bounded runtime-native string.
 *
 * @param value Candidate value.
 * @returns Validated string.
 * @throws Error when the value is absent, empty, or oversized.
 */
function readBoundedString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RUNTIME_HINT_LENGTH) {
    throw invalidRuntimeHint();
  }
  return value;
}

/**
 * Reads one optional bounded runtime-native string.
 *
 * @param value Candidate value.
 * @returns Validated string or undefined.
 */
function readOptionalBoundedString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : readBoundedString(value);
}

/**
 * Validates one required compatibility projection.
 *
 * @param actual Projected value.
 * @param expected Canonical value.
 * @throws Error when the projection differs or is absent.
 */
function requireProjection(actual: unknown, expected: string): void {
  if (actual !== expected) {
    throw invalidRuntimeHint();
  }
}

/**
 * Validates one optional compatibility projection.
 *
 * @param actual Projected value.
 * @param expected Canonical optional value.
 * @throws Error when projection presence or value differs.
 */
function requireOptionalProjection(actual: unknown, expected: string | undefined): void {
  if (expected === undefined ? actual !== undefined && actual !== null : actual !== expected) {
    throw invalidRuntimeHint();
  }
}

/**
 * Reads the pinned Codex sub-agent classification.
 *
 * @param value Canonical sub-agent kind.
 * @returns Normalized supported kind or undefined.
 * @throws Error when the canonical value is outside the pinned contract.
 */
function readSubagentKind(value: unknown): CodexInferenceSubagentKind | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value === 'review' ||
    value === 'compact' ||
    value === 'thread_spawn' ||
    value === 'memory_consolidation' ||
    value === 'other'
  ) {
    return value;
  }
  throw invalidRuntimeHint();
}

/**
 * Validates body and header sub-agent compatibility projections.
 *
 * @param kind Canonical normalized kind.
 * @param bodyValue Body compatibility projection.
 * @param headerValue Header compatibility projection.
 * @returns Normalized sub-agent kind after compatibility validation.
 * @throws Error when either projection conflicts with the canonical kind.
 */
function validateSubagentProjection(
  kind: CodexInferenceSubagentKind | undefined,
  bodyValue: unknown,
  headerValue: string | null
): CodexInferenceSubagentKind | undefined {
  if (!kind) {
    if (bodyValue === 'memory_consolidation' && headerValue === 'memory_consolidation') {
      return 'memory_consolidation';
    }
    requireOptionalProjection(bodyValue, undefined);
    requireOptionalProjection(headerValue, undefined);
    return undefined;
  }

  if (kind === 'other') {
    const label = readBoundedString(bodyValue);
    requireProjection(headerValue, label);
    return kind;
  }

  const expected = kind === 'thread_spawn' ? 'collab_spawn' : kind;
  requireProjection(bodyValue, expected);
  requireProjection(headerValue, expected);
  return kind;
}

/**
 * Creates a stable runtime-hint validation failure.
 *
 * @returns Product-safe validation error.
 */
function invalidRuntimeHint(): Error {
  return new Error('Worker inference runtime hint is invalid.');
}

/** Codex 0.160.0 native inference fields consumed before the generic Core boundary. */
export const codexInferenceRuntimeHintMapping: WorkerInferenceRuntimeHintMapping = {
  headers: [
    'session-id',
    'thread-id',
    'x-client-request-id',
    'x-codex-turn-metadata',
    'x-codex-parent-thread-id',
    'x-openai-subagent',
  ],
  bodyFields: ['client_metadata', 'prompt_cache_key'],
  map: readCodexInferenceRuntimeHint,
};
