import type { RuntimeConfigStatus } from '@openkit/app-api-schemas';
import type { AgentManifest, AuthoredAgentConfig } from '../agents/manifest.js';
import { type AgentReadinessStatus, computeReadiness } from '../agents/readiness.js';
import { type AgentSetupDiagnostic, resolveAgentSetup } from '../agents/setup-resolver.js';
import type { CoreMode } from '../config/mode.js';
import type { OpenKitConfig } from '../config/openkit-config.js';
import type { ProviderCredentialResolver, ProviderRegistry } from '../providers/registry.js';

/**
 * Provider role exposed through setup diagnostics.
 */
export type SetupDiagnosticsProviderRole = 'core' | 'gateway' | 'core+gateway' | 'available';

/**
 * Agent readiness status exposed through setup diagnostics.
 */
export type SetupDiagnosticsAgentStatus = 'ready' | 'degraded' | 'blocked' | 'disabled';

/**
 * Secret marker safe for diagnostics responses.
 */
export interface SetupDiagnosticsSecretMarker {
  /** Whether a secret-bearing field is configured. */
  configured: boolean;
  /** Redacted marker describing the secret source. */
  marker: 'none' | 'redacted' | 'secret-ref';
  /** Secret reference name when it is safe to expose. */
  ref: string | null;
}

/**
 * Server config summary safe for setup diagnostics.
 */
export interface SetupDiagnosticsServerConfig {
  /** Default provider and model ids from server config. */
  defaults: {
    /** Core provider id, when configured. */
    coreProviderId: string | null;
    /** Gateway provider id, when configured. */
    gatewayProviderId: string | null;
  };
  /** OpenAI-compatible gateway summary. */
  gateway: {
    /** Gateway route summary. */
    openaiCompatible: {
      /** Gateway auth marker. */
      auth: SetupDiagnosticsSecretMarker;
      /** Gateway default model id, when configured. */
      defaultModel: string | null;
      /** Gateway default provider id, when configured. */
      defaultProviderId: string | null;
      /** Whether the gateway is enabled in config. */
      enabled: boolean | null;
      /** Gateway route path, when configured. */
      route: string | null;
    };
  };
  /** Server config schema version. */
  schemaVersion: number | null;
}

/**
 * Provider setup diagnostics summary.
 */
export interface SetupDiagnosticsProvider {
  /** Default model id, when configured. */
  defaultModel: string | null;
  /** Human-readable provider name. */
  displayName: string;
  /** Stable provider id. */
  id: string;
  /** Provider kind. */
  kind: string;
  /** Provider role inferred from server defaults. */
  role: SetupDiagnosticsProviderRole;
  /** Redacted secret marker. */
  secret: SetupDiagnosticsSecretMarker;
  /** Provider vendor when known, otherwise provider kind. */
  vendor: string;
}

/**
 * Agent setup diagnostics summary.
 */
export interface SetupDiagnosticsAgent {
  /** Agent display name. */
  displayName: string;
  /** Stable agent id. */
  id: string;
  /** Agent readiness summary. */
  readiness: {
    /** Readiness status. */
    status: SetupDiagnosticsAgentStatus;
    /** Readiness reasons. */
    reasons: string[];
  };
  /** Resolved setup summary. */
  setup: {
    /** Active deployment mode when resolved. */
    deploymentMode: string | null;
    /** Setup diagnostics. */
    diagnostics: AgentSetupDiagnostic[];
    /** Resolved provider id when configured. */
    providerId: string | null;
    /** Setup resolution status. */
    status: SetupDiagnosticsAgentStatus;
  };
}

/**
 * Setup diagnostics response.
 */
export interface SetupDiagnosticsSnapshot {
  /** NanoCore service name. */
  service: 'nanocore';
  /** Server config summary. */
  server: {
    /** Data root used by the app, when known. */
    dataRoot: string | null;
    /** Current NanoCore mode. */
    mode: CoreMode;
    /** Redacted server config summary. */
    config: SetupDiagnosticsServerConfig;
  };
  /** Provider summaries. */
  providers: SetupDiagnosticsProvider[];
  /** Agent setup summaries. */
  agents: SetupDiagnosticsAgent[];
  /** Runtime config reload status. */
  runtimeConfig: RuntimeConfigStatus;
}

/**
 * Input for creating setup diagnostics.
 */
export interface CreateSetupDiagnosticsInput {
  /** Data root used by the app, when known. */
  dataRoot: string | null;
  /** Current NanoCore mode. */
  mode: CoreMode;
  /** Loaded OpenKit server config. */
  openKitConfig: OpenKitConfig;
  /** Provider credential resolver used for readiness checks. */
  providerCredentialResolver?: ProviderCredentialResolver;
  /** Provider registry. */
  providerRegistry: ProviderRegistry;
  /** Authored agent configs available for setup resolution. */
  agentConfigs: AuthoredAgentConfig[];
  /** Agent manifests available for readiness checks. */
  agentManifests: AgentManifest[];
  /** Runtime config reload status. */
  runtimeConfig: RuntimeConfigStatus;
}

/**
 * Creates a redacted setup diagnostics snapshot.
 *
 * @param input Setup diagnostics input.
 * @returns Redacted setup diagnostics snapshot.
 */
export function createSetupDiagnostics(
  input: CreateSetupDiagnosticsInput
): SetupDiagnosticsSnapshot {
  const readinessDependencies = input.providerCredentialResolver
    ? {
        providerCredentialResolver: safeProviderCredentialResolver(
          input.providerCredentialResolver
        ),
      }
    : {};

  return {
    service: 'nanocore',
    server: {
      dataRoot: input.dataRoot,
      mode: input.mode,
      config: summarizeServerConfig(input.openKitConfig),
    },
    providers: input.providerRegistry.list().map((provider) => ({
      defaultModel: provider.defaultModel ?? null,
      displayName: provider.displayName,
      id: provider.id,
      kind: provider.kind,
      role: providerRole(provider.id, input.openKitConfig),
      secret: providerSecretMarker(provider),
      vendor: typeof provider.vendor === 'string' ? provider.vendor : provider.kind,
    })),
    agents: input.agentManifests.map((manifest) =>
      summarizeAgentSetup(
        manifest,
        input.agentConfigs,
        input.providerRegistry,
        readinessDependencies
      )
    ),
    runtimeConfig: input.runtimeConfig,
  };
}

/**
 * Converts provider credential resolver failures into a missing-credential result for diagnostics.
 *
 * @param resolver Provider credential resolver that may throw backend-specific errors.
 * @returns Resolver safe for setup diagnostics rendering.
 */
function safeProviderCredentialResolver(
  resolver: ProviderCredentialResolver
): ProviderCredentialResolver {
  return (secretRef) => {
    try {
      return resolver(secretRef);
    } catch {
      return null;
    }
  };
}

/**
 * Summarizes server config without exposing raw secret-bearing values.
 *
 * @param config OpenKit server config.
 * @returns Redacted server config summary.
 */
function summarizeServerConfig(config: OpenKitConfig): SetupDiagnosticsServerConfig {
  const gatewayConfig = config.gateway?.openaiCompatible;

  return {
    defaults: {
      coreProviderId: config.defaults?.coreProviderId ?? null,
      gatewayProviderId: config.defaults?.gatewayProviderId ?? null,
    },
    gateway: {
      openaiCompatible: {
        auth: rawSecretMarker(gatewayConfig?.auth),
        defaultModel: gatewayConfig?.defaultModel ?? null,
        defaultProviderId: gatewayConfig?.defaultProviderId ?? null,
        enabled: gatewayConfig?.enabled ?? null,
        route: gatewayConfig?.route ?? null,
      },
    },
    schemaVersion: config.schemaVersion ?? null,
  };
}

/**
 * Creates a redacted marker for a raw secret-bearing config value.
 *
 * @param value Raw config value.
 * @returns Secret marker.
 */
function rawSecretMarker(value: unknown): SetupDiagnosticsSecretMarker {
  return {
    configured: typeof value === 'string' && value.length > 0,
    marker: typeof value === 'string' && value.length > 0 ? 'redacted' : 'none',
    ref: null,
  };
}

/**
 * Creates a redacted marker for a provider credential.
 *
 * @param provider Provider profile to inspect.
 * @returns Secret marker.
 */
function providerSecretMarker(
  provider: ReturnType<ProviderRegistry['list']>[number]
): SetupDiagnosticsSecretMarker {
  const secretRef = provider.secretRef;

  return {
    configured: Boolean(secretRef),
    marker: secretRef ? 'secret-ref' : 'none',
    ref: secretRef ?? null,
  };
}

/**
 * Infers a provider role from server config defaults.
 *
 * @param providerId Provider id to inspect.
 * @param config OpenKit server config.
 * @returns Provider role.
 */
function providerRole(providerId: string, config: OpenKitConfig): SetupDiagnosticsProviderRole {
  const coreProviderId = config.defaults?.coreProviderId ?? null;
  const gatewayProviderId =
    config.defaults?.gatewayProviderId ??
    config.gateway?.openaiCompatible?.defaultProviderId ??
    null;
  const isCore = providerId === coreProviderId;
  const isGateway = providerId === gatewayProviderId;

  if (isCore && isGateway) {
    return 'core+gateway';
  }

  if (isCore) {
    return 'core';
  }

  return isGateway ? 'gateway' : 'available';
}

/**
 * Summarizes one agent setup.
 *
 * @param manifest Agent manifest.
 * @param agentConfigs Authored agent configs.
 * @param providerRegistry Provider registry.
 * @param dependencies Readiness dependencies.
 * @returns Agent setup diagnostics summary.
 */
function summarizeAgentSetup(
  manifest: AgentManifest,
  agentConfigs: AuthoredAgentConfig[],
  providerRegistry: ProviderRegistry,
  dependencies: { providerCredentialResolver?: ProviderCredentialResolver }
): SetupDiagnosticsAgent {
  const readiness = computeReadiness(manifest, providerRegistry, dependencies);
  const config = agentConfigs.find((candidate) => candidate.id === manifest.id);
  const setupResult = config ? resolveAgentSetup(config, { providerRegistry }) : null;
  const setupStatus = setupResult
    ? setupResult.diagnostics.length > 0
      ? 'blocked'
      : 'ready'
    : 'degraded';
  const readinessStatus =
    setupStatus === 'blocked' ? 'blocked' : normalizeReadinessStatus(readiness.status);
  const readinessReasons = [
    ...readiness.reasons,
    ...(setupStatus === 'blocked'
      ? (setupResult?.diagnostics.map((diagnostic) => diagnostic.message) ?? [])
      : []),
  ];

  return {
    displayName: manifest.displayName,
    id: manifest.id,
    readiness: {
      reasons: readinessReasons,
      status: readinessStatus,
    },
    setup: {
      deploymentMode: setupResult?.setup?.deployment.mode ?? null,
      diagnostics: setupResult?.diagnostics ?? [],
      providerId: setupResult?.setup?.provider?.providerId ?? manifest.providerRef ?? null,
      status: setupStatus,
    },
  };
}

/**
 * Maps internal readiness statuses onto the setup diagnostics status set.
 *
 * @param status Internal readiness status.
 * @returns Setup diagnostics readiness status.
 */
function normalizeReadinessStatus(status: AgentReadinessStatus): SetupDiagnosticsAgentStatus {
  return status === 'unknown' ? 'degraded' : status;
}
