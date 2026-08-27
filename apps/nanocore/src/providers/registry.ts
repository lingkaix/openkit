import { resolveProviderSubscriptionFamily } from '@openkit/config-schema';

import type { ProviderProfile } from '../config/providers-loader.js';

/** Gateway support matrix for one runtime provider profile. */
export interface ProviderGatewayCapabilities {
  /** Support for `/v1/chat/completions`. */
  readonly chatCompletions: 'native' | 'bridged' | 'unsupported';
  /** Support for `/v1/responses`. */
  readonly responses: 'native' | 'bridged' | 'unsupported';
}

/**
 * Redacted provider summary exposed through app diagnostics.
 */
export interface ProviderRegistrySummary {
  /** Provider endpoint without username or password URL components. */
  baseUrl?: string;
  /** Default model used when a caller does not choose one. */
  defaultModel?: string;
  /** Human-readable provider name. */
  displayName: string;
  /** Stable provider identifier. */
  id: string;
  /** Provider backend family. */
  kind: ProviderProfile['kind'];
  /** Gateway support matrix for this provider profile. */
  gatewayCapabilities: ProviderGatewayCapabilities;
  /** Models declared by the provider profile. */
  models: string[];
  /** Provider readiness state, when configured. */
  readiness?: ProviderProfile['readiness'];
}

/**
 * Resolves a provider credential reference to a usable credential value.
 *
 * @param secretRef Provider credential reference.
 * @returns Secret value when resolvable, otherwise null.
 */
export type ProviderCredentialResolver = (secretRef: string) => string | null;

const unresolvedProviderCredential: ProviderCredentialResolver = () => null;

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
 * In-memory provider registry built from loaded provider profiles.
 */
export class ProviderRegistry {
  private readonly providersById: Map<string, ProviderProfile>;

  /**
   * Creates a provider registry.
   *
   * @param profiles Loaded provider profiles.
   */
  public constructor(profiles: ProviderProfile[]) {
    this.providersById = new Map(profiles.map((profile) => [profile.id, profile]));
  }

  /**
   * Lists loaded provider profiles.
   *
   * @returns Provider profiles in registry insertion order.
   */
  public list(): ProviderProfile[] {
    return [...this.providersById.values()];
  }

  /**
   * Gets a provider profile by id.
   *
   * @param id Provider id.
   * @returns Provider profile when present, otherwise null.
   */
  public get(id: string): ProviderProfile | null {
    return this.providersById.get(id) ?? null;
  }

  /**
   * Checks whether a provider has every credential required for use.
   *
   * @param id Provider id to inspect.
   * @param credentialResolver Resolver used to check credential references.
   * @returns True when usable, false when credentials are missing, or null for unknown ids.
   */
  public hasResolvableCredentials(
    id: string,
    credentialResolver: ProviderCredentialResolver = unresolvedProviderCredential
  ): boolean | null {
    const provider = this.get(id);

    if (!provider) {
      return null;
    }

    return (
      !providerRequiresCredentials(provider) ||
      Boolean(resolveProviderSecretRef(provider, credentialResolver))
    );
  }

  /**
   * Returns redacted provider summaries safe for diagnostics responses.
   *
   * @returns Redacted provider summaries.
   */
  public summarize(): ProviderRegistrySummary[] {
    return this.list().map((profile) => {
      const summary: ProviderRegistrySummary = {
        displayName: profile.displayName,
        id: profile.id,
        kind: profile.kind,
        gatewayCapabilities: gatewayCapabilitiesForProfile(profile),
        models: [...profile.models],
      };

      if (profile.baseUrl) {
        summary.baseUrl = redactBaseUrl(profile.baseUrl);
      }
      if (profile.defaultModel) {
        summary.defaultModel = profile.defaultModel;
      }
      if (profile.readiness) {
        summary.readiness = profile.readiness;
      }

      return summary;
    });
  }
}

/**
 * Checks whether a provider profile requires a credential before use.
 *
 * @param profile Provider profile to inspect.
 * @returns True for hosted provider kinds or profiles that explicitly declare credentials.
 */
export function providerRequiresCredentials(profile: ProviderProfile): boolean {
  return profile.kind === 'direct' || profile.kind === 'gateway' || Boolean(profile.secretRef);
}

/**
 * Resolves a provider credential reference.
 *
 * @param profile Provider profile to inspect.
 * @param credentialResolver Resolver used to check credential references.
 * @returns Resolved credential value when available, otherwise null.
 */
export function resolveProviderSecretRef(
  profile: ProviderProfile,
  credentialResolver: ProviderCredentialResolver = unresolvedProviderCredential
): string | null {
  return profile.secretRef ? credentialResolver(profile.secretRef) : null;
}

/**
 * Resolves supported env: credential references from process.env.
 *
 * @param secretRef Provider credential reference.
 * @returns Environment variable value when present, otherwise null.
 */
export function resolveEnvSecretRef(secretRef: string): string | null {
  const envName = secretRef.startsWith('env:') ? secretRef.slice('env:'.length) : null;

  return envName ? (process.env[envName] ?? null) : null;
}

/**
 * Removes username and password components from a provider URL.
 *
 * @param baseUrl Provider base URL.
 * @returns Redacted URL, or the original value when parsing fails.
 */
function redactBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';

    return url.toString();
  } catch {
    return baseUrl;
  }
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
    return { chatCompletions: 'native', responses: 'native' };
  }

  if (subscriptionFamily === 'openai-codex') {
    return { chatCompletions: 'bridged', responses: 'native' };
  }

  return { chatCompletions: 'native', responses: 'bridged' };
}
