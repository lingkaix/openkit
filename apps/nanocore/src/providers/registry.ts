import type { ProviderRegistryEntry } from '@openkit/app-api-schemas';
import { resolveProviderSubscriptionFamily } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import type { ProviderProfile } from '../config/providers-loader.js';
import { resolveProviderModelDiagnostic } from '../llm/logical-models.js';
import {
  gatewayCapabilitiesForProfile,
  type ProviderGatewayCapabilities,
  providerRequiresCredentials,
} from './profile-capabilities.js';

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
  /** Active exact extension key and effective metadata for deployment administration. */
  metadataKey: string;
  /** Safe subscription pair identity; no credential or upstream account identity. */
  subscriptionAccount?: ProviderRegistryEntry['subscriptionAccount'];
  /** Effective values resolved against active loaded metadata. */
  modelDetails: NonNullable<ProviderRegistryEntry['modelDetails']>;
  /** Provider readiness state, when configured. */
  readiness?: ProviderProfile['readiness'];
}

/** Existing consuming operation facts for the linked Vault Audit, never credential authority. */
export interface ProviderCredentialUseContext {
  /** Actual actor admitted by the consuming operation. */
  readonly actor: ActorRef;
  /** Existing consuming Workspace audience when available. */
  readonly consumerWorkspaceId?: string;
  /** Existing consuming AgentSession when available. */
  readonly agentSessionId?: string;
  /** Existing capability call correlation when available. */
  readonly capabilityCallId?: string;
}

/**
 * Resolves a provider credential reference to a usable credential value.
 *
 * @param secretRef Provider credential reference.
 * @param context Actual consuming operation facts when admitted.
 * @returns Secret value when resolvable, otherwise null.
 */
export type ProviderCredentialResolver = (
  secretRef: string,
  context?: ProviderCredentialUseContext
) => string | null | Promise<string | null>;

/** Tests configured credential presence without resolving Vault material. */
export type ProviderCredentialConfigured = (secretRef: string | undefined) => boolean;

const unresolvedProviderCredential: ProviderCredentialResolver = () => null;

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
  public async hasResolvableCredentials(
    id: string,
    credentialResolver: ProviderCredentialResolver = unresolvedProviderCredential
  ): Promise<boolean | null> {
    const provider = this.get(id);

    if (!provider) {
      return null;
    }

    return (
      !providerRequiresCredentials(provider) ||
      Boolean(await resolveProviderSecretRef(provider, credentialResolver))
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
        metadataKey: profile.vendor ?? profile.id,
        modelDetails: profile.models.map((id) => resolveProviderModelDiagnostic(profile, id)),
      };

      const family = resolveProviderSubscriptionFamily(profile);
      const slot = profile.extensions?.openkit?.subscriptionAccount?.accountSlotId;
      if (profile.kind === 'oauth' && family && slot)
        summary.subscriptionAccount = { subscriptionProviderId: family, accountSlotId: slot };
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
 * Resolves a provider credential reference.
 *
 * @param profile Provider profile to inspect.
 * @param credentialResolver Resolver used to check credential references.
 * @returns Resolved credential value when available, otherwise null.
 */
export async function resolveProviderSecretRef(
  profile: ProviderProfile,
  credentialResolver: ProviderCredentialResolver = unresolvedProviderCredential
): Promise<string | null> {
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
