import type { OpenKitConfig } from '../config/openkit-config.js';
import type { ProviderCredentialResolver, ProviderRegistry } from './registry.js';

/**
 * Reason a configured default provider is unavailable.
 */
export type DefaultProviderUnavailableReason = 'unset' | 'unknown-id' | 'credentials-missing';

/**
 * Origin of a resolved role-specific default provider.
 */
export type DefaultProviderOrigin = 'canonical' | 'unset';

/**
 * App diagnostics state for the operator-configured default provider.
 */
export type DefaultProviderState =
  | {
      /** Whether the default provider exists and has required credentials. */
      configured: true;
      /** Configured provider id. */
      providerId: string;
    }
  | {
      /** Whether the default provider exists and has required credentials. */
      configured: false;
      /** Reason the default provider is not usable. */
      reason: 'unset';
    }
  | {
      /** Whether the default provider exists and has required credentials. */
      configured: false;
      /** Configured provider id. */
      providerId: string;
      /** Reason the configured provider is not usable. */
      reason: Exclude<DefaultProviderUnavailableReason, 'unset'>;
    };

/**
 * App diagnostics state for one role-specific default provider.
 */
export type RoleDefaultProviderState =
  | {
      /** Whether the default provider exists and has required credentials. */
      configured: true;
      /** Optional configured model for this default role. */
      model: string | null;
      /** Origin of the resolved provider id. */
      origin: Exclude<DefaultProviderOrigin, 'unset'>;
      /** Configured provider id. */
      providerId: string;
    }
  | {
      /** Whether the default provider exists and has required credentials. */
      configured: false;
      /** Origin of the resolved provider id. */
      origin: 'unset';
      /** Reason the default provider is not usable. */
      reason: 'unset';
    }
  | {
      /** Whether the default provider exists and has required credentials. */
      configured: false;
      /** Optional configured model for this default role. */
      model: string | null;
      /** Origin of the resolved provider id. */
      origin: Exclude<DefaultProviderOrigin, 'unset'>;
      /** Configured provider id. */
      providerId: string;
      /** Reason the configured provider is not usable. */
      reason: Exclude<DefaultProviderUnavailableReason, 'unset'>;
    };

/**
 * App diagnostics state for Core and gateway default providers.
 */
export interface DefaultProviderStates {
  /** Default provider used by NanoCore's own LLM calls. */
  core: RoleDefaultProviderState;
  /** Default provider used by the agent-facing gateway. */
  gateway: RoleDefaultProviderState;
}

interface DefaultProviderSelection {
  model: string | null;
  origin: DefaultProviderOrigin;
  providerId: string | null;
}

/**
 * Resolves PRD v0.0.3 Section 5 default-provider app diagnostics state.
 *
 * @param config Loaded OpenKit operator config.
 * @param providerRegistry Provider registry loaded from config/provider profiles.
 * @param credentialResolver Resolver used to check provider credential references.
 * @returns Default provider diagnostics state for /api/app/diagnostics.
 */
export function resolveDefaultProviderState(
  config: OpenKitConfig,
  providerRegistry: ProviderRegistry,
  credentialResolver?: ProviderCredentialResolver
): DefaultProviderState {
  const providerId = config.defaults?.coreProviderId;

  if (!providerId) {
    return { configured: false, reason: 'unset' };
  }

  if (!providerRegistry.get(providerId)) {
    return { configured: false, providerId, reason: 'unknown-id' };
  }

  if (!providerRegistry.hasResolvableCredentials(providerId, credentialResolver)) {
    return { configured: false, providerId, reason: 'credentials-missing' };
  }

  return { configured: true, providerId };
}

/**
 * Resolves role-specific Core and gateway default-provider diagnostics state.
 *
 * @param config Loaded OpenKit operator config.
 * @param providerRegistry Provider registry loaded from config/provider profiles.
 * @param credentialResolver Resolver used to check provider credential references.
 * @returns Default provider diagnostics state for Core and gateway roles.
 */
export function resolveDefaultProviderStates(
  config: OpenKitConfig,
  providerRegistry: ProviderRegistry,
  credentialResolver?: ProviderCredentialResolver
): DefaultProviderStates {
  return {
    core: resolveRoleDefaultProviderState(
      selectRoleDefaultProvider(config, 'core'),
      providerRegistry,
      credentialResolver
    ),
    gateway: resolveRoleDefaultProviderState(
      selectRoleDefaultProvider(config, 'gateway'),
      providerRegistry,
      credentialResolver
    ),
  };
}

/**
 * Selects a provider id and model for one default-provider role.
 *
 * @param config Loaded OpenKit operator config.
 * @param role Default-provider role to resolve.
 * @returns Selected provider id, model, and origin.
 */
function selectRoleDefaultProvider(
  config: OpenKitConfig,
  role: 'core' | 'gateway'
): DefaultProviderSelection {
  const defaults = config.defaults;

  if (role === 'core' && defaults?.coreProviderId) {
    return {
      model: defaults.coreModel ?? null,
      origin: 'canonical',
      providerId: defaults.coreProviderId,
    };
  }

  if (role === 'gateway' && defaults?.gatewayProviderId) {
    return {
      model: defaults.gatewayModel ?? null,
      origin: 'canonical',
      providerId: defaults.gatewayProviderId,
    };
  }

  return {
    model: null,
    origin: 'unset',
    providerId: null,
  };
}

/**
 * Resolves one role-specific default-provider state.
 *
 * @param selection Selected provider id and origin.
 * @param providerRegistry Provider registry loaded from config/provider profiles.
 * @param credentialResolver Resolver used to check provider credential references.
 * @returns Role-specific default-provider diagnostics state.
 */
function resolveRoleDefaultProviderState(
  selection: DefaultProviderSelection,
  providerRegistry: ProviderRegistry,
  credentialResolver?: ProviderCredentialResolver
): RoleDefaultProviderState {
  if (!selection.providerId || selection.origin === 'unset') {
    return { configured: false, origin: 'unset', reason: 'unset' };
  }

  if (!providerRegistry.get(selection.providerId)) {
    return {
      configured: false,
      model: selection.model,
      origin: selection.origin,
      providerId: selection.providerId,
      reason: 'unknown-id',
    };
  }

  if (!providerRegistry.hasResolvableCredentials(selection.providerId, credentialResolver)) {
    return {
      configured: false,
      model: selection.model,
      origin: selection.origin,
      providerId: selection.providerId,
      reason: 'credentials-missing',
    };
  }

  return {
    configured: true,
    model: selection.model,
    origin: selection.origin,
    providerId: selection.providerId,
  };
}
