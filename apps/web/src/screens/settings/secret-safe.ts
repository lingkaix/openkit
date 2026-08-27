/**
 * Secret-safe projection helpers for Settings surfaces (WP-7).
 *
 * The Web UI must never render raw secrets or backend-private runtime state.
 * These helpers strip known secret-shaped fields and redact secret-looking
 * substrings at the projection boundary before any DOM render.
 */

/** Known object keys that commonly carry credentials or tokens. */
const SECRET_FIELD_NAMES = new Set([
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'password',
  'secret',
  'token',
  'authorization',
  'authUrl',
  'userCode',
]);

/** Matches common raw-secret prefixes that must never reach the DOM. */
const RAW_SECRET_PATTERN =
  /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)/g;

/** Replacement shown when a secret-shaped substring is redacted. */
export const REDACTED_LABEL = '[redacted]';

/**
 * Redacts secret-shaped substrings from free text.
 *
 * @param value Candidate display string.
 * @returns Text with raw-secret prefixes replaced.
 */
export function redactSecretShapedText(value: string): string {
  return value.replace(RAW_SECRET_PATTERN, `$1${REDACTED_LABEL}`);
}

/**
 * Returns whether a key is treated as secret-bearing for projection.
 *
 * @param key Object key.
 * @returns True when the key must be dropped before render.
 */
export function isSecretFieldName(key: string): boolean {
  if (SECRET_FIELD_NAMES.has(key)) return true;
  return /api[-_]?key|secret|password|token|authorization/i.test(key);
}

/**
 * Deep-clones a value while dropping known secret field names.
 *
 * @param value Arbitrary payload.
 * @returns Clone without secret-named fields.
 */
export function stripSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecretFields(item));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isSecretFieldName(key)) continue;
      output[key] = stripSecretFields(nested);
    }
    return output;
  }
  return value;
}

/**
 * Projects an arbitrary value into a DOM-safe shape: drops secret keys and
 * redacts secret-shaped strings recursively.
 *
 * @param value Arbitrary API payload or nested field.
 * @returns Projection safe to stringify or render as text.
 */
export function projectSafeValue(value: unknown): unknown {
  const stripped = stripSecretFields(value);
  return redactNested(stripped);
}

/**
 * Recursively redacts secret-shaped strings inside a stripped value.
 *
 * @param value Value already stripped of secret keys.
 * @returns Fully redacted projection.
 */
function redactNested(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecretShapedText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNested(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactNested(nested)])
    );
  }
  return value;
}

/** Status chip vocabulary for provider-subscription account status. */
export type ProviderSubscriptionStatusTone =
  | 'positive'
  | 'informative'
  | 'notice'
  | 'negative'
  | 'neutral';

/**
 * Maps a provider-subscription account status to plain-language chip copy.
 *
 * @param status Public provider-subscription status from Core Client.
 * @returns Label and semantic tone for a StatusChip.
 */
export function providerSubscriptionAccountStatusLabel(status: string): {
  label: string;
  tone: ProviderSubscriptionStatusTone;
} {
  switch (status) {
    case 'logged_in':
      return { label: 'Connected', tone: 'positive' };
    case 'pending':
      return { label: 'Connecting', tone: 'informative' };
    case 'error':
      return { label: 'Needs attention', tone: 'negative' };
    case 'unavailable':
      return { label: 'Unavailable', tone: 'notice' };
    default:
      return { label: 'Not connected', tone: 'neutral' };
  }
}
