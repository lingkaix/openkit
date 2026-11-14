import { resolveProviderSubscriptionFamily } from '@openkit/config-schema';
import type { ProviderProfile } from '../config/providers-loader.js';

/** Gateway support matrix for one runtime provider profile. */
export interface ProviderGatewayCapabilities {
  /** Private decision support. An undeclared capability never admits a decision call. */
  readonly decisions?: 'native' | 'bridged' | 'unsupported';
  /** Support for `/v1/chat/completions`. */
  readonly chatCompletions: 'native' | 'bridged' | 'unsupported';
  /** Support for `/v1/responses`. */
  readonly responses: 'native' | 'bridged' | 'unsupported';
}

/**
 * Normalizes a provider id for adapter and policy comparisons.
 *
 * @param id Provider id supplied by config or dispatch.
 * @returns Lowercase id with hyphen and underscore separators unified.
 */
export function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase().replaceAll('-', '_');
}

/**
 * Checks whether a provider profile requires a credential before use.
 *
 * @param profile Provider profile to inspect.
 * @returns True for hosted provider kinds or profiles that explicitly declare credentials.
 */
export function providerRequiresCredentials(profile: ProviderProfile): boolean {
  return profile.kind === 'direct' || profile.kind === 'llm-gateway' || Boolean(profile.secretRef);
}

/**
 * Derives gateway entry-point capabilities from a loaded provider profile.
 *
 * @param profile Provider profile to inspect.
 * @returns Gateway capability matrix.
 */
export function gatewayCapabilitiesForProfile(
  profile: ProviderProfile
): ProviderGatewayCapabilities {
  const vendor = (profile as { vendor?: unknown }).vendor;
  const vendorId = typeof vendor === 'string' ? normalizeProviderId(vendor) : null;
  const profileId = normalizeProviderId(profile.id);
  const subscriptionFamily = resolveProviderSubscriptionFamily(profile);

  if (profileId === 'openai' || vendorId === 'openai') {
    return { chatCompletions: 'native', responses: 'native', decisions: 'native' };
  }

  if (subscriptionFamily === 'openai-codex' || subscriptionFamily === 'xai') {
    return { chatCompletions: 'bridged', responses: 'native', decisions: 'bridged' };
  }

  return { chatCompletions: 'native', responses: 'bridged', decisions: 'bridged' };
}

/**
 * Checks whether provider readiness permits dispatch.
 *
 * @param profile Provider profile to inspect.
 * @returns True when readiness is omitted, ready, or degraded.
 */
export function isProviderProfileDispatchable(profile: ProviderProfile): boolean {
  return (
    profile.readiness === undefined ||
    profile.readiness.status === 'ready' ||
    profile.readiness.status === 'degraded'
  );
}
