import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Fixed prefix for OpenKit server-issued access-token secrets. */
export const OPENKIT_ACCESS_TOKEN_PREFIX = 'okt_';

const ACCESS_TOKEN_RANDOM_BYTES = 32;
const TOKEN_PATTERN = /^okt_[A-Za-z0-9_-]+$/;

/** Closed v1 OpenKit access-token scope set. */
export type OpenKitAccessTokenScope = 'server-admin' | 'workspace' | 'workspace-readonly';

/** Durable OpenKit access-token status values. */
export type OpenKitAccessTokenStatus = 'active' | 'expired' | 'revoked' | 'rotated';

/** Normalized OpenKit access-token scope binding. */
export interface OpenKitAccessTokenScopeBinding {
  /** Token scope. */
  scope: OpenKitAccessTokenScope;
  /** Workspace ids bound to workspace-scoped tokens. */
  workspaceIds: string[];
}

/** Minimal durable token state needed for auth-layer usability checks. */
export interface OpenKitAccessTokenUsabilityInput {
  /** Current token status. */
  status: OpenKitAccessTokenStatus;
  /** Expiration timestamp. */
  expiresAt: string;
  /** Optional rotation grace expiration timestamp. */
  rotatedGraceExpiresAt?: string | null | undefined;
}

/** Result of checking whether a token record may authenticate a request. */
export type OpenKitAccessTokenUsability =
  | { usable: true }
  | { reason: 'expired' | 'revoked' | 'rotated'; usable: false };

/**
 * Creates one opaque OpenKit access-token secret.
 *
 * @returns URL-safe token secret with the `okt_` prefix.
 */
export function createOpenKitAccessTokenSecret(): string {
  return `${OPENKIT_ACCESS_TOKEN_PREFIX}${randomBytes(ACCESS_TOKEN_RANDOM_BYTES).toString('base64url')}`;
}

/**
 * Checks whether a value has the OpenKit access-token secret shape.
 *
 * @param value Candidate value.
 * @returns True when the value is an `okt_` URL-safe token secret.
 */
export function isOpenKitAccessTokenSecret(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/**
 * Hashes an OpenKit access-token secret for durable storage.
 *
 * @param secret Plaintext token secret.
 * @returns Versioned SHA-256 token hash.
 */
export function hashOpenKitAccessTokenSecret(secret: string): string {
  if (!isOpenKitAccessTokenSecret(secret)) {
    throw new Error('OpenKit access token secret must use the okt_ prefix.');
  }

  return `sha256:${createHash('sha256').update(secret).digest('hex')}`;
}

/**
 * Verifies one presented token secret against a stored token hash.
 *
 * @param secret Presented token secret.
 * @param expectedHash Stored versioned token hash.
 * @returns True when the secret matches the stored hash.
 */
export function verifyOpenKitAccessTokenSecret(secret: string, expectedHash: string): boolean {
  if (!isOpenKitAccessTokenSecret(secret) || !expectedHash.startsWith('sha256:')) {
    return false;
  }

  const actual = Buffer.from(hashOpenKitAccessTokenSecret(secret));
  const expected = Buffer.from(expectedHash);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Normalizes and validates one access-token scope binding.
 *
 * @param scope Token scope.
 * @param workspaceIds Workspace ids bound to workspace-scoped tokens.
 * @returns Normalized scope binding.
 */
export function normalizeOpenKitAccessTokenScope(
  scope: OpenKitAccessTokenScope,
  workspaceIds: readonly string[]
): OpenKitAccessTokenScopeBinding {
  const uniqueWorkspaceIds = [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))];

  if (scope === 'server-admin') {
    if (uniqueWorkspaceIds.length > 0) {
      throw new Error('server-admin tokens must not carry workspace bindings.');
    }

    return { scope, workspaceIds: [] };
  }

  if (uniqueWorkspaceIds.length === 0) {
    throw new Error(`${scope} tokens must bind at least one workspace id.`);
  }

  return { scope, workspaceIds: uniqueWorkspaceIds };
}

/**
 * Evaluates whether one token record may authenticate now.
 *
 * @param token Token status and expiry fields.
 * @param now Current time.
 * @returns Usability result for auth-layer verification.
 */
export function evaluateOpenKitAccessTokenUsability(
  token: OpenKitAccessTokenUsabilityInput,
  now = new Date()
): OpenKitAccessTokenUsability {
  if (token.status === 'revoked') {
    return { reason: 'revoked', usable: false };
  }

  if (Date.parse(token.expiresAt) <= now.getTime()) {
    return { reason: 'expired', usable: false };
  }

  if (token.status === 'rotated') {
    const grace = token.rotatedGraceExpiresAt ? Date.parse(token.rotatedGraceExpiresAt) : 0;
    return grace > now.getTime() ? { usable: true } : { reason: 'rotated', usable: false };
  }

  if (token.status === 'expired') {
    return { reason: 'expired', usable: false };
  }

  return { usable: true };
}
