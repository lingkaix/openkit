import type { ProviderProfile } from '../config/providers-loader.js';
import { isCodexOAuthProviderProfile, readCodexOAuthAccountSlotId } from './codex-oauth-profile.js';
import {
  gatewayCapabilitiesForProfile,
  normalizeProviderId,
  type ProviderCredentialResolver,
  type ProviderGatewayCapabilities,
  providerRequiresCredentials,
  resolveProviderSecretRef,
} from './registry.js';

/** Secret-bearing provider configuration used by internal LLM callers. */
export interface ResolvedLLMProviderConfig {
  /** Pi AI adapter identity, distinct from the configured instance id. */
  readonly adapterId: string;
  /** Resolved credential, never returned through app APIs. */
  readonly apiKey: string | null;
  /** Runtime backend used for dispatch. */
  readonly backend: 'codex-oauth' | 'pi-ai';
  /** Effective provider endpoint. */
  readonly baseUrl: string | null;
  /** Human-readable provider name. */
  readonly displayName: string;
  /** OpenAI-compatible extra request body fields. */
  readonly extraBody: Record<string, unknown>;
  /** OpenAI-compatible extra request headers. */
  readonly extraHeaders: Record<string, string>;
  /** Gateway endpoint support matrix. */
  readonly gatewayCapabilities: ProviderGatewayCapabilities;
  /** Configured provider instance id. */
  readonly id: string;
  /** Whether dispatch requires an explicit credential. */
  readonly requiresApiKey: boolean;
  /** Codex OAuth account slot for subscription providers. */
  readonly codexOAuthAccountSlotId?: string;
}

/**
 * Converts a runtime provider profile into the secret-bearing config used by LLM clients.
 *
 * @param profile Provider profile loaded from runtime config.
 * @param credentialResolver Optional secret-ref resolver.
 * @returns Resolved provider config for Gateway dispatch.
 */
export function resolveProviderProfileToLLMConfig(
  profile: ProviderProfile,
  credentialResolver?: ProviderCredentialResolver
): ResolvedLLMProviderConfig {
  const baseUrl = profile.baseUrl ?? null;
  const isCodexOAuth = isCodexOAuthProviderProfile(profile);
  const adapterId = isCodexOAuth ? 'openai_codex' : readProviderAdapterId(profile);
  const apiKey = resolveProviderSecretRef(profile, credentialResolver);
  const codexOAuthAccountSlotId = readCodexOAuthAccountSlotId(profile);

  return {
    adapterId,
    apiKey,
    backend: isCodexOAuth ? 'codex-oauth' : 'pi-ai',
    baseUrl,
    displayName: profile.displayName,
    extraBody: readStringRecord((profile as { extraBody?: unknown }).extraBody),
    extraHeaders: readStringHeaders((profile as { extraHeaders?: unknown }).extraHeaders),
    gatewayCapabilities: gatewayCapabilitiesForProfile(profile),
    id: profile.id,
    requiresApiKey: isCodexOAuth ? false : providerRequiresCredentials(profile),
    ...(codexOAuthAccountSlotId ? { codexOAuthAccountSlotId } : {}),
  };
}

/**
 * Reads the adapter identity declared by a runtime provider profile.
 *
 * @param profile Provider profile loaded from runtime config.
 * @returns Declared vendor id, or the configured instance id when no vendor is present.
 */
function readProviderAdapterId(profile: ProviderProfile): string {
  const vendor = (profile as { vendor?: unknown }).vendor;

  return normalizeProviderId(typeof vendor === 'string' && vendor.trim() ? vendor : profile.id);
}

function readStringHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function readStringRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
