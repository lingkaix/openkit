import { ApiCallError } from '@openkit/core-client';
import { fillCopy, timelineCopy } from './copy';
import { formatRelativeAge } from './time';

/** Connection postures the timeline banner can show. */
export type ConnectionPosture =
  | 'connected'
  | 'checking'
  | 'reconnecting'
  | 'offline'
  | 'busy'
  | 'out-of-date'
  | 'unreachable';

/** How a failed send is shown. The client does not queue it. */
export type SendFailureKind = 'not-sent' | 'unknown' | 'kept';

/** Server error class. Unmapped codes stay neutral. */
export type RunErrorClass = 'work' | 'system' | 'needs-you' | 'unknown' | 'unmapped';

const SYSTEM_CODES = new Set([
  'provider_unavailable',
  'quota_exhausted',
  'rate_limited',
  'context_overflow',
  'output_limit',
  'unsupported',
  'worker_governance_turn_failed',
  'worker_start_failed',
  'worker_preparation_failed',
  'worker_governance_restart_recovery',
  'git_fetch_failed',
  'git_fetch_tls_failed',
  'git_fetch_transport_failed',
  'git_fetch_http_refused',
  'sandbox_network_denied',
]);

const NEEDS_YOU_CODES = new Set([
  'auth_rejected',
  'workspace_access_denied',
  'provider_api_key_missing',
]);

const UNKNOWN_CODES = new Set(['delivery_unknown', 'recovery_required', 'unknown']);

const PROVIDER_CODES = new Set(['provider_unavailable', 'quota_exhausted', 'rate_limited']);

/** Clock time of the last successful load, as the banner names it. */
export function formatLoadedTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Offline sentence. The time is the last load this mount admitted. */
export function offlineSentence(loadedAt: number | null): string {
  if (loadedAt == null || loadedAt <= 0) return timelineCopy.offlinePaused;
  return fillCopy(timelineCopy.offlineAt, { time: formatLoadedTime(loadedAt) });
}

/** Seconds to wait before the next reconnect. Base steps are 1, 2, 4 … 30. */
export function backoffDelayMs(attempt: number, random = Math.random()): number {
  const seconds = Math.min(30, 2 ** Math.max(0, attempt));
  const jitter = 0.5 + Math.min(1, Math.max(0, random)) * 0.5;
  return Math.round(seconds * jitter * 1000);
}

/**
 * Retry delay from an error body.
 * // TB6: HTTP Retry-After is not on ApiCallError, so only details.retryAfter is honored.
 */
export function readRetryAfterSeconds(error: unknown, now = Date.now()): number {
  if (error instanceof ApiCallError && error.details && typeof error.details === 'object') {
    const value = (error.details as { retryAfter?: unknown }).retryAfter;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.ceil(value);
    if (typeof value === 'string') {
      const asNumber = Number(value);
      if (value.trim() !== '' && Number.isFinite(asNumber) && asNumber >= 0) {
        return Math.ceil(asNumber);
      }
      const date = Date.parse(value);
      if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
    }
  }
  return 20;
}

/** True when the status is the server-busy pair. */
export function isBusyStatus(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 429 || error.status === 503);
}

/** True when the stream cursor can no longer be resumed. */
export function isCursorExpired(error: unknown): boolean {
  return (
    error instanceof ApiCallError &&
    (error.status === 410 || error.code === 'core.stream.cursor_expired')
  );
}

/** A denied read. Cached content from it must not stay on screen. */
export function isDeniedRead(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}

/** Classifies a send failure. A transport loss is unknown, not a confirmed refusal. */
export function classifySendFailure(error: unknown): SendFailureKind {
  if (error instanceof ApiCallError && error.code === 'thread_busy') return 'kept';
  if (error instanceof ApiCallError) {
    if (error.status === 0 || error.status === 408 || error.status === 504 || error.status >= 500) {
      return 'unknown';
    }
    return 'not-sent';
  }
  if (error instanceof TypeError) return 'unknown';
  if (error instanceof Error && /lost|network|fetch|abort|timeout/i.test(error.message)) {
    return 'unknown';
  }
  return 'not-sent';
}

/** Copy for a send failure. Never describes the failure as a worker report. */
export function sendFailureCopy(kind: SendFailureKind): string {
  if (kind === 'kept') return timelineCopy.keepDraft;
  if (kind === 'unknown') return timelineCopy.sendUnknown;
  return timelineCopy.notSent;
}

/** Maps a Turn error code that exists today. Null and unknown codes stay neutral. */
export function classifyRunError(code: string | null | undefined): {
  class: RunErrorClass;
  text: string;
} {
  if (code && SYSTEM_CODES.has(code)) {
    return {
      class: 'system',
      text: PROVIDER_CODES.has(code)
        ? timelineCopy.providerUnavailable
        : timelineCopy.systemProblem,
    };
  }
  if (code && NEEDS_YOU_CODES.has(code))
    return { class: 'needs-you', text: timelineCopy.needsAccount };
  if (code && UNKNOWN_CODES.has(code))
    return { class: 'unknown', text: timelineCopy.unknownOutcome };
  // TB6: the server does not send an error class. Work-problem codes are not on today's Turn error.
  return { class: 'unmapped', text: timelineCopy.runEndedNeutral };
}

/** "Updated N min ago" after three missed refreshes. Otherwise nothing. */
export function freshnessCopy(
  missedRefreshes: number,
  updatedAt: number,
  now: number
): string | null {
  if (missedRefreshes < 3 || updatedAt <= 0) return null;
  return fillCopy(timelineCopy.updatedAgo, { ago: formatRelativeAge(now - updatedAt) });
}

interface SnapshotItem {
  id: string;
  status?: string;
  text?: string;
}

/**
 * An in-place edit whose Item count did not change.
 * A count change is a different recovery, so this stays false when the lengths differ.
 */
export function lostUpdateSameCount(
  cached: readonly SnapshotItem[],
  embedded: readonly SnapshotItem[]
): boolean {
  if (cached.length === 0 || cached.length !== embedded.length) return false;
  const next = new Map(embedded.map((item) => [item.id, item]));
  if (cached.some((item) => !next.has(item.id))) return false;
  return cached.some((item) => {
    const other = next.get(item.id);
    return other != null && (item.text !== other.text || item.status !== other.status);
  });
}
