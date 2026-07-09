import type { ProviderProfile } from '../config/providers-loader.js';

/**
 * Conventional server-owned Codex OAuth account slot id.
 */
export const CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID = 'default';

/**
 * Valid server-owned Codex OAuth account slot identifier pattern.
 */
export const CODEX_OAUTH_ACCOUNT_SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Checks whether a provider profile targets ChatGPT subscription inference through Codex.
 *
 * @param profile Provider profile loaded from runtime config.
 * @returns True when the profile should use the Codex OAuth backend.
 */
export function isCodexOAuthProviderProfile(profile: ProviderProfile): boolean {
  return (
    profile.id === 'openai_codex' ||
    (profile as { vendor?: unknown }).vendor === 'openai_codex' ||
    Boolean(readOpenKitCodexOAuthExtension(profile))
  );
}

/**
 * Reads the Codex OAuth account slot configured on a provider profile.
 *
 * @param profile Provider profile loaded from runtime config.
 * @returns Account slot id for Codex profiles, otherwise null.
 */
export function readCodexOAuthAccountSlotId(profile: ProviderProfile): string | null {
  const accountSlotId = readOpenKitCodexOAuthExtension(profile)?.accountSlotId;

  if (
    typeof accountSlotId === 'string' &&
    CODEX_OAUTH_ACCOUNT_SLOT_ID_PATTERN.test(accountSlotId)
  ) {
    return accountSlotId;
  }

  return null;
}

/**
 * Validates one account slot id.
 *
 * @param accountSlotId Account slot id to validate.
 * @returns The original slot id when valid.
 * @throws Error when the slot id is invalid.
 */
export function validateCodexOAuthAccountSlotId(accountSlotId: string): string {
  if (!CODEX_OAUTH_ACCOUNT_SLOT_ID_PATTERN.test(accountSlotId)) {
    throw new Error(`Invalid Codex OAuth account slot id: ${accountSlotId}`);
  }

  return accountSlotId;
}

interface OpenKitCodexOAuthExtension {
  readonly accountSlotId?: unknown;
}

function readOpenKitCodexOAuthExtension(
  profile: ProviderProfile
): OpenKitCodexOAuthExtension | null {
  const extensions = (profile as { extensions?: unknown }).extensions;

  if (!extensions || typeof extensions !== 'object') {
    return null;
  }

  const openkit = (extensions as { openkit?: unknown }).openkit;

  if (!openkit || typeof openkit !== 'object') {
    return null;
  }

  const codexOAuth = (openkit as { codexOAuth?: unknown }).codexOAuth;

  return codexOAuth && typeof codexOAuth === 'object'
    ? (codexOAuth as OpenKitCodexOAuthExtension)
    : null;
}
