import { normalizeProviderId } from './provider-registry.js';

/**
 * Gateway policy configuration input.
 */
export interface GatewayPolicyInput {
  /** Whether the agent-facing LLM gateway is enabled. */
  readonly enabled?: boolean;
  /** Optional provider allowlist for gateway routing. */
  readonly allowedProviderIds?: readonly string[];
}

/**
 * Sanitized gateway policy state.
 */
export interface GatewayPolicy {
  /** Whether the agent-facing LLM gateway is enabled. */
  readonly enabled: boolean;
  /** Normalized provider allowlist, or null when all configured providers are allowed. */
  readonly allowedProviderIds: readonly string[] | null;
}

/**
 * App-local gateway policy store.
 */
export class GatewayPolicyStore {
  private policy: GatewayPolicy;

  /**
   * Create gateway policy state.
   *
   * @param input Optional initial policy controls.
   */
  public constructor(input: GatewayPolicyInput = {}) {
    this.policy = {
      enabled: input.enabled ?? true,
      allowedProviderIds: input.allowedProviderIds
        ? input.allowedProviderIds.map((providerId) => normalizeProviderId(providerId))
        : null,
    };
  }

  /**
   * Return current sanitized gateway policy.
   *
   * @returns Current gateway policy.
   */
  public getPolicy(): GatewayPolicy {
    return {
      enabled: this.policy.enabled,
      allowedProviderIds: this.policy.allowedProviderIds
        ? [...this.policy.allowedProviderIds]
        : null,
    };
  }

  /**
   * Check whether a provider can be used by the gateway.
   *
   * @param providerId Provider ID selected for routing.
   * @returns True when gateway routing is allowed for this provider.
   */
  public allowsProvider(providerId: string): boolean {
    if (!this.policy.enabled) {
      return false;
    }

    if (!this.policy.allowedProviderIds) {
      return true;
    }

    return this.policy.allowedProviderIds.includes(normalizeProviderId(providerId));
  }
}
