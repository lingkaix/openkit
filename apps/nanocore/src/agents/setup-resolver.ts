import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type { ProviderRegistry } from '../providers/registry.js';
import type { AuthoredAgentConfig } from './manifest.js';
import { type ResolvedAgentTransport, resolveAgentTransport } from './transport.js';

/**
 * Origin marker for resolved agent setup sections.
 */
export type AgentSetupOrigin =
  | 'adapter-defaults'
  | 'server-policy'
  | 'server-providers'
  | 'agent-config'
  | 'agent-file'
  | 'user-override'
  | 'workspace-override'
  | 'runtime';

/**
 * Agent setup resolver diagnostic.
 */
export interface AgentSetupDiagnostic {
  /** Stable diagnostic code. */
  code:
    | 'agent_setup.invalid_transport'
    | 'agent_setup.missing_provider'
    | 'agent_setup.missing_deployment'
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
 * Resolved active deployment block.
 */
export interface ResolvedAgentDeployment {
  /** Active deployment block payload. */
  config: Record<string, unknown>;
  /** Active agent deployment mode. */
  mode: AuthoredAgentConfig['mode'];
  /** Origin of the deployment payload. */
  origin: AgentSetupOrigin;
}

/**
 * Resolved backend requirements declared by the authored agent setup.
 */
export interface ResolvedAgentBackendRequirements {
  /** Backend kinds allowed by the authored setup. */
  allowedKinds: AgentEnvironmentPackage['backend']['allowedKinds'];
  /** Origin of the backend requirement payload. */
  origin: AgentSetupOrigin;
  /** Preferred backend kind, when declared. */
  preferred: AgentEnvironmentPackage['backend']['preferred'] | null;
  /** Backend capabilities required by this setup. */
  requiredCapabilities: AgentEnvironmentPackage['backend']['requiredCapabilities'];
}

/**
 * Typed authored backend requirements after config-schema validation.
 */
type AuthoredBackendRequirementsView = {
  /** Backend kinds allowed by the authored setup. */
  allowedKinds?: AgentEnvironmentPackage['backend']['allowedKinds'];
  /** Preferred backend kind, when declared. */
  preferred?: AgentEnvironmentPackage['backend']['preferred'];
  /** Backend capabilities required by this setup. */
  requiredCapabilities: AgentEnvironmentPackage['backend']['requiredCapabilities'];
};

/**
 * Resolved agent setup used before materialization.
 */
export interface ResolvedAgentSetup {
  /** Required manifest feature ids supported by the resolver for this setup. */
  requiredFeatures: string[];
  /** Authored backend requirements to carry into AEP resolution. */
  backend: ResolvedAgentBackendRequirements | null;
  /** Active deployment block. */
  deployment: ResolvedAgentDeployment;
  /** Origin metadata for major sections. */
  origins: {
    /** Runtime origin. */
    runtime: AgentSetupOrigin;
    /** Transport origin. */
    transport: AgentSetupOrigin;
    /** Deployment origin. */
    deployment: AgentSetupOrigin;
    /** Provider origin. */
    provider: AgentSetupOrigin | null;
  };
  /** Resolved provider, when configured. */
  provider: ResolvedAgentProvider | null;
  /** Agent runtime summary. */
  runtime: {
    /** Runtime adapter id. */
    adapter: string;
    /** Runtime family. */
    kind: string;
    /** Runtime version, when configured. */
    version: string | null;
  };
  /** Effective agent transport. */
  transport: ResolvedAgentTransport;
  /** Agent identity summary. */
  agent: {
    /** Agent display name. */
    displayName: string;
    /** Agent id. */
    id: string;
  };
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
 * Resolves an authored agent config into one inspectable setup value.
 *
 * @param config Authored agent config.
 * @param dependencies Resolver dependencies.
 * @returns Resolved setup or blocking diagnostics.
 */
export function resolveAgentSetup(
  config: AuthoredAgentConfig,
  dependencies: AgentSetupResolverDependencies
): AgentSetupResolveResult {
  const diagnostics: AgentSetupDiagnostic[] = [];
  const activeDeployment = readActiveDeployment(config);
  const backend = resolveBackendRequirements(config);
  const provider = resolveProvider(config, dependencies.providerRegistry, diagnostics);
  const transport = resolveTransport(config, diagnostics);
  const requiredFeatures = config.requiredFeatures ?? [];
  rejectUnsupportedRequiredFeatures(config.id, requiredFeatures, dependencies, diagnostics);

  if (!activeDeployment) {
    diagnostics.push({
      code: 'agent_setup.missing_deployment',
      message: `Agent ${config.id} does not define an active ${config.mode} deployment block.`,
      severity: 'error',
      agentId: config.id,
    });
  }

  if (diagnostics.length > 0 || !activeDeployment || !transport) {
    return { diagnostics, setup: null };
  }

  return {
    diagnostics: [],
    setup: {
      requiredFeatures: [...requiredFeatures],
      backend,
      deployment: {
        config: activeDeployment,
        mode: config.mode,
        origin: 'agent-config',
      },
      origins: {
        deployment: 'agent-config',
        provider: provider ? 'server-providers' : null,
        runtime: 'agent-config',
        transport: transport.origin,
      },
      provider,
      runtime: {
        adapter: config.runtime.adapter,
        kind: config.runtime.kind,
        version: config.runtime.version ?? null,
      },
      transport,
      agent: {
        displayName: config.displayName,
        id: config.id,
      },
    },
  };
}

/**
 * Reads authored backend requirements from the sandbox section.
 *
 * @param config Authored agent config.
 * @returns Resolved backend requirements, or null when not declared.
 */
function resolveBackendRequirements(
  config: AuthoredAgentConfig
): ResolvedAgentBackendRequirements | null {
  const backend = (config.sandbox as { backend?: AuthoredBackendRequirementsView } | undefined)
    ?.backend;

  if (!backend) {
    return null;
  }

  return {
    allowedKinds: [...(backend.allowedKinds ?? [])],
    origin: 'agent-config',
    preferred: backend.preferred ?? null,
    requiredCapabilities: [...backend.requiredCapabilities],
  };
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
 * Resolves and validates the agent transport.
 *
 * @param config Authored agent config.
 * @param diagnostics Diagnostics collection to append to.
 * @returns Resolved agent transport when valid.
 */
function resolveTransport(
  config: AuthoredAgentConfig,
  diagnostics: AgentSetupDiagnostic[]
): ResolvedAgentTransport | null {
  try {
    return resolveAgentTransport(config);
  } catch (error) {
    diagnostics.push({
      code: 'agent_setup.invalid_transport',
      message: error instanceof Error ? error.message : String(error),
      severity: 'error',
      agentId: config.id,
    });
    return null;
  }
}

/**
 * Reads the deployment block for the active mode.
 *
 * @param config Authored agent config.
 * @returns Active deployment payload when present.
 */
function readActiveDeployment(config: AuthoredAgentConfig): Record<string, unknown> | null {
  const deployment = config.deployment[config.mode];

  return typeof deployment === 'object' && deployment !== null && !Array.isArray(deployment)
    ? (deployment as Record<string, unknown>)
    : null;
}

/**
 * Resolves the agent provider reference through the server provider registry.
 *
 * @param config Authored agent config.
 * @param providerRegistry Provider registry.
 * @param diagnostics Diagnostics collection to append to.
 * @returns Resolved provider snapshot when configured.
 */
function resolveProvider(
  config: AuthoredAgentConfig,
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
