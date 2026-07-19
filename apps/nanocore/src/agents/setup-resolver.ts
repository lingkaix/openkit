import type { ProviderRegistry } from '../providers/registry.js';
import type { AgentManifest } from './manifest.js';

/**
 * Origin marker for resolved agent setup sections.
 */
export type AgentSetupOrigin = 'server-providers';

/**
 * Agent setup resolver diagnostic.
 */
export interface AgentSetupDiagnostic {
  /** Stable diagnostic code. */
  code:
    | 'agent_setup.invalid_default_profile'
    | 'agent_setup.missing_provider'
    | 'agent_setup.unsupported_required_feature';
  /** Human-readable diagnostic message. */
  message: string;
  /** Diagnostic severity. */
  severity: 'error';
  /** Agent id associated with the diagnostic. */
  agentId: string;
}

/**
 * Resolved agent provider reference safe for snapshots.
 */
export interface ResolvedAgentProvider {
  /** Selected model id, when configured. */
  model: string | null;
  /** Origin of the selected provider. */
  origin: AgentSetupOrigin;
  /** Provider id from the server provider registry. */
  providerId: string;
  /** Secret reference marker, never a resolved secret value. */
  secretRef: string | null;
}

/**
 * Resolved agent setup used before materialization.
 */
export interface ResolvedAgentSetup {
  /** Complete selected authored manifest. */
  manifest: AgentManifest;
  /** Resolved provider, when configured. */
  provider: ResolvedAgentProvider | null;
}

/**
 * Agent setup resolver result.
 */
export interface AgentSetupResolveResult {
  /** Blocking diagnostics discovered during resolution. */
  diagnostics: AgentSetupDiagnostic[];
  /** Resolved setup when no blocking diagnostics were produced. */
  setup: ResolvedAgentSetup | null;
}

/**
 * Dependencies required by the agent setup resolver.
 */
export interface AgentSetupResolverDependencies {
  /** Provider registry used to resolve provider refs. */
  providerRegistry: ProviderRegistry;
  /** Required feature ids supported by this resolver. */
  supportedRequiredFeatures?: readonly string[];
}

/**
 * Resolves one authored manifest and its provider reference into an inspectable setup value.
 *
 * @param config Authored agent manifest.
 * @param dependencies Resolver dependencies.
 * @returns Resolved setup or blocking diagnostics.
 */
export function resolveAgentSetup(
  config: AgentManifest,
  dependencies: AgentSetupResolverDependencies
): AgentSetupResolveResult {
  const diagnostics: AgentSetupDiagnostic[] = [];
  const provider = resolveProvider(config, dependencies.providerRegistry, diagnostics);
  const requiredFeatures = config.requiredFeatures ?? [];
  rejectInvalidDefaultProfile(config, diagnostics);
  rejectUnsupportedRequiredFeatures(config.id, requiredFeatures, dependencies, diagnostics);

  if (diagnostics.length > 0) {
    return { diagnostics, setup: null };
  }

  return {
    diagnostics: [],
    setup: {
      manifest: config,
      provider,
    },
  };
}

/**
 * Rejects an explicit default profile id that is absent from the manifest profile list.
 *
 * @param config Authored agent manifest to validate.
 * @param diagnostics Diagnostics collection to append to.
 */
function rejectInvalidDefaultProfile(
  config: AgentManifest,
  diagnostics: AgentSetupDiagnostic[]
): void {
  const defaultProfileId = config.defaultProfileId;
  if (!defaultProfileId || config.profiles?.some((profile) => profile.id === defaultProfileId)) {
    return;
  }

  diagnostics.push({
    agentId: config.id,
    code: 'agent_setup.invalid_default_profile',
    message: `Agent ${config.id} default profile ${defaultProfileId} is not declared in profiles.`,
    severity: 'error',
  });
}

/**
 * Adds blocking diagnostics for required features this resolver cannot honor.
 *
 * @param agentId Agent id associated with diagnostics.
 * @param requiredFeatures Required manifest feature ids.
 * @param dependencies Resolver dependencies.
 * @param diagnostics Diagnostics collection to append to.
 */
function rejectUnsupportedRequiredFeatures(
  agentId: string,
  requiredFeatures: readonly string[],
  dependencies: AgentSetupResolverDependencies,
  diagnostics: AgentSetupDiagnostic[]
): void {
  const supported = new Set(dependencies.supportedRequiredFeatures ?? []);

  for (const feature of requiredFeatures) {
    if (!supported.has(feature)) {
      diagnostics.push({
        code: 'agent_setup.unsupported_required_feature',
        message: `Agent ${agentId} requires unsupported feature: ${feature}.`,
        severity: 'error',
        agentId,
      });
    }
  }
}

/**
 * Resolves the agent provider reference through the server provider registry.
 *
 * @param config Authored agent manifest.
 * @param providerRegistry Provider registry.
 * @param diagnostics Diagnostics collection to append to.
 * @returns Resolved provider snapshot when configured.
 */
function resolveProvider(
  config: AgentManifest,
  providerRegistry: ProviderRegistry,
  diagnostics: AgentSetupDiagnostic[]
): ResolvedAgentProvider | null {
  const providerRef = config.provider?.ref;

  if (!providerRef) {
    return null;
  }

  const provider = providerRegistry.get(providerRef);

  if (!provider) {
    diagnostics.push({
      code: 'agent_setup.missing_provider',
      message: `Agent ${config.id} references missing provider: ${providerRef}.`,
      severity: 'error',
      agentId: config.id,
    });
    return null;
  }

  return {
    model: config.provider?.model ?? provider.defaultModel ?? null,
    origin: 'server-providers',
    providerId: provider.id,
    secretRef: provider.secretRef ?? null,
  };
}
