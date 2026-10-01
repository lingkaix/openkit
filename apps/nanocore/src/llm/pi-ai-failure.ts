import {
  type AssistantMessage,
  isContextOverflow,
  isRetryableAssistantError,
} from '@earendil-works/pi-ai';

/** Attempt-local failure kinds owned by the Gateway failure table. */
export type PiAiFailureKind =
  | 'auth_rejected'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'context_overflow'
  | 'unsupported'
  | 'output_limit'
  | 'refused'
  | 'invalid_request'
  | 'cancelled'
  | 'unknown';

/** Observed adapter evidence, without synthetic transport status or routing policy. */
export interface PiAiFailure {
  /** Closed Gateway failure category. */
  readonly kind: PiAiFailureKind;
  /** Positive replay evidence: Provider response/terminal rejection or proven pre-send failure. */
  readonly settled: boolean;
  /** Actual exposed upstream HTTP status. */
  readonly status?: number;
  /** Actual exposed provider code or error type. */
  readonly providerCode?: string;
  /** Actual exposed Retry-After header, interpreted by the Gateway retry owner. */
  readonly retryAfter?: string;
}

/** Reads adapter fields without assigning evidence to unexposed properties. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Classifies thrown errors and terminal pi-ai events/results using exposed evidence only.
 * Stock-wrapped errors default to uncertain unless affirmative Provider or pre-send evidence exists.
 *
 * @param input Original adapter error, terminal error event, or assistant result before wrapping.
 * @returns One closed failure value, or undefined for a successful protocol result.
 */
export function classifyPiAiFailure(input: unknown): PiAiFailure | undefined {
  const event = record(input);
  const source =
    event.type === 'error' && record(event.error).stopReason !== undefined
      ? record(event.error)
      : event.type === 'done'
        ? record(event.message)
        : event;
  if (
    typeof source.stopReason === 'string' &&
    source.stopReason !== 'error' &&
    source.stopReason !== 'aborted'
  )
    return undefined;
  const response = record(source.response);
  const nested = record(source.error);
  const statusValue = source.status ?? response.status;
  const status =
    typeof statusValue === 'number' &&
    Number.isInteger(statusValue) &&
    statusValue >= 100 &&
    statusValue <= 599
      ? statusValue
      : undefined;
  const codeValue = source.code ?? nested.code ?? nested.type ?? source.type;
  const providerCode = typeof codeValue === 'string' ? codeValue : undefined;
  const headers = source.headers ?? response.headers;
  const retryValue =
    headers instanceof Headers ? headers.get('retry-after') : record(headers)['retry-after'];
  const retryAfter = typeof retryValue === 'string' ? retryValue : undefined;
  const messageValue =
    source.errorMessage ??
    source.message ??
    nested.message ??
    (typeof input === 'string' ? input : '');
  const message = typeof messageValue === 'string' ? messageValue : '';
  const text = [providerCode, source.rawStopReason, message]
    .filter((value) => typeof value === 'string')
    .join(' ');
  const refusalCode =
    /^(?:refusal|content_filter|SAFETY|BLOCKLIST|PROHIBITED_CONTENT|SPII|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT)$/;
  // Classification can recognize broad wording; replay needs a retained Provider code, including inline codes in stock terminal messages.
  const rejectionCode =
    /\b(insufficient_quota|usage_limit_reached|usage_not_included|subscription_sharing_usage_limit_exceeded|GoUsageLimitError|FreeUsageLimitError|invalid_api_key|authentication_error|invalid_token|unauthorized|unsupported_parameter|unsupported_feature|unsupported_gateway_feature|not_supported|rate_limit_exceeded|rate_limit_error|rate_limited|ThrottlingException|invalid_request_error|invalid_request|validation_error)\b/i;
  const providerRefusal =
    refusalCode.test(providerCode ?? '') ||
    refusalCode.test(typeof source.rawStopReason === 'string' ? source.rawStopReason : '') ||
    /^(?:Response incomplete: |Provider stopped with: |Error Code )?(?:refusal|content_filter|SAFETY|BLOCKLIST|PROHIBITED_CONTENT|SPII|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT)(?::|\s*$)/.test(
      message
    );
  let kind: PiAiFailureKind = 'unknown';
  if (
    source.stopReason === 'aborted' ||
    source.name === 'AbortError' ||
    providerCode === 'ABORT_ERR' ||
    source.rawStopReason === 'cancelled'
  )
    kind = 'cancelled';
  else if (
    /\b(insufficient_quota|usage_limit_reached|usage_not_included|subscription_sharing_usage_limit_exceeded|GoUsageLimitError|FreeUsageLimitError)\b|You have hit your ChatGPT usage limit|Monthly usage limit reached|out of budget|quota exceeded|exceeded your current quota|credit balance is too low|billing (?:limit|hard limit|quota)/i.test(
      text
    )
  )
    kind = 'quota_exhausted';
  else if (
    isContextOverflow({
      ...source,
      stopReason: 'error',
      errorMessage: message,
    } as unknown as AssistantMessage)
  )
    kind = 'context_overflow';
  else if (
    status === 401 ||
    /\b(invalid_api_key|authentication_error|invalid_token|unauthorized)\b|Incorrect API key provided|No API key found|Provider is not configured|^401(?:\s|:|$)/i.test(
      text
    )
  )
    kind = 'auth_rejected';
  else if (providerRefusal) kind = 'refused';
  else if (
    /\b(max_tokens|max_output_tokens|max_completion_tokens)\b.*(?:too (?:large|high)|exceed|at most|must be (?:less|<=))|output token limit.*(?:exceed|reject)/i.test(
      text
    )
  )
    kind = 'output_limit';
  else if (
    /\b(unsupported_parameter|unsupported_feature|unsupported_gateway_feature|not_supported)\b|Unsupported (?:parameter|endpoint|feature)|not supported (?:with|by|for) this model/i.test(
      text
    )
  )
    kind = 'unsupported';
  else if (
    status === 429 ||
    /\brate[_ -]?limit(?:_exceeded|_error|ed)?\b|too many requests|^Throttling error:|\bThrottlingException\b|^429(?:\s|:|$)/i.test(
      text.trim()
    )
  )
    kind = 'rate_limited';
  else if (
    status === 400 ||
    status === 422 ||
    /\b(invalid_request_error|invalid_request|validation_error)\b/i.test(text)
  )
    kind = 'invalid_request';
  // Terminal evidence precedes pi-ai's deliberately broad transient patterns (500, timeout, terminated).
  // Keep only exposed HTTP status, Node codes absent upstream, and this adapter's stream diagnostics local.
  else if (
    status === 408 ||
    (status !== undefined && status >= 500) ||
    /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|Provider stream (?:failed|ended)/i.test(
      text
    ) ||
    isRetryableAssistantError({
      ...source,
      stopReason: 'error',
      errorMessage: text,
    } as unknown as AssistantMessage)
  )
    kind = 'provider_unavailable';
  return {
    kind,
    // Stock lazyStream's wrapper and retryable wording supply no delivery proof; default to uncertain and admit only affirmative evidence.
    settled:
      status !== undefined ||
      /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|connection refused|\bconnect (?:ETIMEDOUT|timeout|timed out)\b/i.test(
        text
      ) ||
      rejectionCode.test(providerCode ?? '') ||
      refusalCode.test(providerCode ?? '') ||
      (source.stopReason === 'error' && (rejectionCode.test(message) || providerRefusal)),
    ...(status === undefined ? {} : { status }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

/**
 * Attaches one non-enumerable failure value for downstream routing without changing ordinary error identity.
 *
 * @param error Existing thrown value; immutable values require an Error with the original cause.
 * @param source Original adapter evidence, before diagnostic/status wrapping.
 * @returns Error carrying its failure value; ordinary fields and extensible-object identity survive.
 */
export function attachPiAiFailure(error: unknown, source: unknown = error): unknown {
  const target =
    error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error
      : new Error(String(error));
  if ('failure' in target) return target;
  const failure = classifyPiAiFailure(source);
  if (!failure) return error;
  if (!Object.isExtensible(target))
    return Object.defineProperty(
      Object.assign(
        new Error(target instanceof Error ? target.message : String(target), { cause: target }),
        target
      ),
      'failure',
      { value: failure }
    );
  Object.defineProperty(target, 'failure', { value: failure, enumerable: false });
  return target;
}
