import type { RuntimeConfigStatus, SetupDiagnosticsResponse } from '@openkit/app-api-schemas';
import type { GatewayConfig } from '@openkit/config-schema';
import type { AgentManifest } from '../agents/manifest.js';
import { type AgentReadinessStatus, computeReadiness } from '../agents/readiness.js';
import { resolveAgentSetup } from '../agents/setup-resolver.js';
import type { CoreMode } from '../config/mode.js';
import type { OpenKitConfig } from '../config/openkit-config.js';
import type { ProviderRegistry } from '../providers/registry.js';

type SetupDiagnosticsAgentStatus =
  SetupDiagnosticsResponse['agents'][number]['readiness']['status'];
type SetupDiagnosticsSecretMarker = SetupDiagnosticsResponse['providers'][number]['secret'];
type SetupDiagnosticsServerConfig = SetupDiagnosticsResponse['server']['config'];
type SetupDiagnosticsAgent = SetupDiagnosticsResponse['agents'][number];

/**
 * Input for creating setup diagnostics.
 */
interface CreateSetupDiagnosticsInput {
  /** Data root used by the app, when known. */
  dataRoot: string | null;
  /** Current NanoCore mode. */
  mode: CoreMode;
  /** Loaded OpenKit server config. */
  openKitConfig: OpenKitConfig;
  /** Current Gateway logical model catalog. */
  gatewayConfig: GatewayConfig;
  /** Provider registry. */
  providerRegistry: ProviderRegistry;
  /** Agent manifests available for setup and readiness checks. */
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
): SetupDiagnosticsResponse {
  return {
    service: 'nanocore',
    server: {
      dataRoot: input.dataRoot ? 'configured' : null,
      mode: input.mode,
      config: summarizeServerConfig(input.openKitConfig),
    },
    providers: input.providerRegistry.list().map((provider) => ({
      defaultModel: provider.defaultModel ?? null,
      displayName: provider.displayName,
      id: provider.id,
      kind: provider.kind,
      role: 'available',
      secret: providerSecretMarker(provider),
      vendor: typeof provider.vendor === 'string' ? provider.vendor : provider.kind,
    })),
    agents: input.agentManifests.map((manifest) =>
      summarizeAgentSetup(manifest, input.gatewayConfig, input.providerRegistry)
    ),
    runtimeConfig: input.runtimeConfig,
  };
}

/**
 * Summarizes server config without exposing raw secret-bearing values.
 *
 * @param config OpenKit server config.
 * @returns Redacted server config summary.
 */
function summarizeServerConfig(config: OpenKitConfig): SetupDiagnosticsServerConfig {
  return {
    defaultAgentId: config.defaults?.defaultAgentId ?? null,
    schemaVersion: config.schemaVersion ?? null,
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
 * Summarizes one agent setup.
 *
 * @param manifest Agent manifest.
 * @param providerRegistry Provider registry.
 * @returns Agent setup diagnostics summary.
 */
function summarizeAgentSetup(
  manifest: AgentManifest,
  gatewayConfig: GatewayConfig,
  providerRegistry: ProviderRegistry
): SetupDiagnosticsAgent {
  const readiness = computeReadiness(manifest);
  const setupResult = resolveAgentSetup(manifest, { gatewayConfig, providerRegistry });
  const setupStatus = setupResult.diagnostics.length > 0 ? 'blocked' : 'ready';
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
      deploymentMode: null,
      diagnostics: setupResult.diagnostics,
      logicalModelId: setupResult.setup?.logicalModels.preferredLogicalModelId ?? null,
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
