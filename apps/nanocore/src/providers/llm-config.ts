import type { ProviderProfile } from '../config/providers-loader.js';
import type { LLMProviderApiKeySource, ResolvedLLMProviderConfig } from '../llm/provider-config.js';
import type { LLMProviderSpec } from '../llm/provider-registry.js';
import { findProviderSpec } from '../llm/provider-registry.js';
import { isCodexOAuthProviderProfile, readCodexOAuthAccountSlotId } from './codex-oauth-profile.js';
import {
  gatewayCapabilitiesForProfile,
  type ProviderCredentialResolver,
  resolveProviderSecretRef,
} from './registry.js';

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
  const spec = createProviderSpecFromProfile(profile);
  const apiKey = resolveProviderSecretRef(profile, credentialResolver);
  const codexOAuthAccountSlotId = readCodexOAuthAccountSlotId(profile);

  return {
    apiKey,
    apiKeySource: readResolvedCredentialSource(profile.secretRef, apiKey),
    baseUrl,
    displayName: profile.displayName,
    extraBody: readStringRecord((profile as { extraBody?: unknown }).extraBody),
    extraHeaders: readStringHeaders((profile as { extraHeaders?: unknown }).extraHeaders),
    gatewayCapabilities: spec.gatewayCapabilities,
    hasApiKey: Boolean(apiKey),
    id: profile.id,
    model: profile.defaultModel ?? null,
    spec,
    specId: profile.id,
    ...(codexOAuthAccountSlotId ? { codexOAuthAccountSlotId } : {}),
  };
}

/**
 * Creates static provider metadata required by shared LLM client types.
 *
 * @param profile Provider profile loaded from runtime config.
 * @returns Provider spec projection.
 */
export function createProviderSpecFromProfile(profile: ProviderProfile): LLMProviderSpec {
  const isCodexOAuth = isCodexOAuthProviderProfile(profile);
  const isCustomOpenAICompatible = profile.kind === 'custom';
  const staticSpec = findProviderSpec(profile.id);

  if (staticSpec && !isCodexOAuth) {
    return {
      ...staticSpec,
      defaultBaseUrl: profile.baseUrl ?? staticSpec.defaultBaseUrl,
      displayName: profile.displayName,
      envKey: readEnvSecretName(profile.secretRef) ?? staticSpec.envKey,
      isGateway: profile.kind === 'gateway',
      isLocal: profile.kind === 'local',
      isOAuth: profile.kind === 'oauth',
      requiresApiKey: providerProfileRequiresApiKey(profile),
    };
  }

  return {
    backend: isCodexOAuth ? 'codex-oauth' : 'pi-ai',
    defaultBaseUrl: profile.baseUrl ?? null,
    displayName: profile.displayName,
    envKey: readEnvSecretName(profile.secretRef),
    extraBodyAllowed: !isCustomOpenAICompatible,
    extraHeadersAllowed: !isCustomOpenAICompatible,
    gatewayCapabilities: gatewayCapabilitiesForProfile(profile),
    id: profile.id,
    isGateway: profile.kind === 'gateway',
    isLocal: profile.kind === 'local',
    isOAuth: isCodexOAuth || profile.kind === 'oauth',
    modelKeywords: [],
    requiresApiKey: isCodexOAuth ? false : providerProfileRequiresApiKey(profile),
    supportsReasoning:
      isCodexOAuth ||
      isCustomOpenAICompatible ||
      (profile as { vendor?: unknown }).vendor === 'openai',
    supportsStreaming: true,
    supportsToolCalls: true,
  };
}

/**
 * Returns whether a runtime provider profile requires an API key.
 *
 * @param profile Runtime provider profile.
 * @returns True when the profile declares a credential or is hosted.
 */
function providerProfileRequiresApiKey(profile: ProviderProfile): boolean {
  return profile.kind === 'direct' || profile.kind === 'gateway' || Boolean(profile.secretRef);
}

/**
 * Reads an environment variable name from an env secret reference.
 *
 * @param secretRef Secret reference.
 * @returns Environment variable name, when supported.
 */
export function readEnvSecretName(secretRef: string | undefined): string | null {
  return secretRef?.startsWith('env:') ? secretRef.slice('env:'.length) : null;
}

/**
 * Classifies a resolved provider credential source.
 *
 * @param secretRef Provider secret reference.
 * @param apiKey Resolved provider credential value.
 * @returns Non-secret source label for diagnostics and internal dispatch.
 */
export function readResolvedCredentialSource(
  secretRef: string | undefined,
  apiKey: string | null
): LLMProviderApiKeySource {
  if (!apiKey) {
    return secretRef ? 'missing' : 'not-required';
  }

  return secretRef?.startsWith('vault://') ? 'vault' : 'env';
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
