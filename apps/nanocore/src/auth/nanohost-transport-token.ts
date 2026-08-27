import {
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
  isOpenKitAccessTokenSecret,
  verifyOpenKitAccessTokenSecret,
} from './access-token.js';

/** Closed NanoHost transport Token type. */
export const NANOHOST_TRANSPORT_TOKEN_TYPE = 'nanohost-transport' as const;

/** Closed NanoHost transport Token scope. */
export const NANOHOST_TRANSPORT_TOKEN_SCOPE = 'nanohost-transport' as const;

/** Closed NanoHost transport Token type. */
export type NanoHostTransportTokenType = typeof NANOHOST_TRANSPORT_TOKEN_TYPE;

/** Closed NanoHost transport Token scope. */
export type NanoHostTransportTokenScope = typeof NANOHOST_TRANSPORT_TOKEN_SCOPE;

/** Durable NanoHost transport Token lifecycle statuses. */
export type NanoHostTransportTokenStatus = 'active' | 'expired' | 'revoked' | 'rotated';

/** Minimal durable token state needed for auth-layer usability checks. */
export interface NanoHostTransportTokenUsabilityInput {
  /** Current token status. */
  status: NanoHostTransportTokenStatus;
  /** Expiration timestamp. */
  expiresAt: string;
  /** Optional rotation overlap deadline for a rotated predecessor. */
  rotationOverlapExpiresAt?: string | null | undefined;
}

/** Result of checking whether a NanoHost transport token may authenticate. */
export type NanoHostTransportTokenUsability =
  | { usable: true }
  | { reason: 'expired' | 'revoked' | 'rotated'; usable: false };

export {
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
  isOpenKitAccessTokenSecret,
  verifyOpenKitAccessTokenSecret,
};

/**
 * Evaluates whether one NanoHost transport Token record may authenticate now.
 *
 * @param token Token status and expiry fields.
 * @param now Current time.
 * @returns Usability result for auth-layer verification.
 */
export function evaluateNanoHostTransportTokenUsability(
  token: NanoHostTransportTokenUsabilityInput,
  now = new Date()
): NanoHostTransportTokenUsability {
  if (token.status === 'revoked') {
    return { reason: 'revoked', usable: false };
  }

  if (Date.parse(token.expiresAt) <= now.getTime()) {
    return { reason: 'expired', usable: false };
  }

  if (token.status === 'rotated') {
    const overlap = token.rotationOverlapExpiresAt ? Date.parse(token.rotationOverlapExpiresAt) : 0;
    return overlap > now.getTime() ? { usable: true } : { reason: 'rotated', usable: false };
  }

  if (token.status === 'expired') {
    return { reason: 'expired', usable: false };
  }

  return { usable: true };
}
