import type {
  AppDiagnosticsResponse,
  BootReadinessSnapshot,
  DIAGNOSTICS_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { CoreMode } from '../config/mode.js';
import type { RuntimeConfigManager, RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { GatewayUsageTracker } from '../llm/gateway-usage.js';
import { resolveLogicalModelCatalog } from '../llm/logical-models.js';
import type { FamilyImplementations } from '../operation-contract.js';
import type { ProviderCredentialConfigured } from '../providers/registry.js';
import type { TurnExecutor } from '../runtime/types.js';
import { mapRuntimeCapabilitiesToFlags } from '../service-routes.js';
import { createProcessDiagnosticsSample } from './process-sample.js';
import { createSetupDiagnostics } from './setup.js';

/** Samples existing diagnostics owners only after common deployment-administrator admission. */
export function createDiagnosticsOperationImplementations(
  services:
    | {
        readonly runtimeConfig: () => RuntimeConfigSnapshot;
        readonly runtimeConfigManager: RuntimeConfigManager;
        readonly getBootReadiness: () => BootReadinessSnapshot;
        readonly gatewayUsageTracker: GatewayUsageTracker;
        readonly turnExecutor: TurnExecutor;
        readonly providerSubscriptionAccountManager?: Parameters<
          typeof resolveLogicalModelCatalog
        >[2];
        readonly providerCredentialConfigured: ProviderCredentialConfigured;
        readonly dataRoot: string | null;
        readonly mode: CoreMode;
      }
    | undefined
) {
  return {
    'diagnostics.app': () => {
      const {
        runtimeConfig,
        runtimeConfigManager,
        getBootReadiness,
        gatewayUsageTracker,
        turnExecutor,
        providerSubscriptionAccountManager,
        providerCredentialConfigured,
      } = services!;
      return {
        service: 'nanocore',
        boot: getBootReadiness(),
        process: createProcessDiagnosticsSample(),
        gateway: {
          status: 'ok',
          endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses'],
          defaultModelId: runtimeConfig().gatewayConfig.defaultLogicalModelId ?? null,
          models: resolveLogicalModelCatalog(
            runtimeConfig().gatewayConfig,
            runtimeConfig().providerRegistry,
            providerSubscriptionAccountManager ?? undefined,
            providerCredentialConfigured
          ).map(
            ({
              id,
              displayName,
              capabilities,
              autoFailover,
              routes,
              contract,
              reasoningEffortLevels,
              contextManagement,
            }) => ({
              id,
              displayName,
              capabilities: [...capabilities],
              autoFailover,
              routes: routes.map((route) => ({
                ...route,
                // The shared output validator enforces the closed supply-reason vocabulary.
                unavailableReason: route.unavailableReason as NonNullable<
                  AppDiagnosticsResponse['gateway']['models'][number]['routes']
                >[number]['unavailableReason'],
              })),
              contract: contract
                ? {
                    ...contract,
                    inputModalities: contract.inputModalities
                      ? [...contract.inputModalities]
                      : null,
                  }
                : undefined,
              reasoningEffortLevels: reasoningEffortLevels ? [...reasoningEffortLevels] : undefined,
              contextManagement,
            })
          ),
          usage: gatewayUsageTracker.snapshot(),
        },
        providers: {
          diagnostics: runtimeConfig().providerDiagnostics.summaries,
          registry: runtimeConfig().providerRegistry.summarize(),
        },
        // Diagnostics mirrors protocol-visible capabilities for one consistent app surface.
        capabilities: mapRuntimeCapabilitiesToFlags(turnExecutor.capabilities),
        runtimeConfig: runtimeConfigManager.status(),
      };
    },
    'diagnostics.setup': () => {
      const { dataRoot, runtimeConfig, mode, runtimeConfigManager } = services!;
      return createSetupDiagnostics({
        dataRoot,
        gatewayConfig: runtimeConfig().gatewayConfig,
        mode,
        openKitConfig: runtimeConfig().openKitConfig,
        providerRegistry: runtimeConfig().providerRegistry,
        agentManifests: runtimeConfig().agentManifests,
        runtimeConfig: runtimeConfigManager.status(),
      });
    },
  } satisfies FamilyImplementations<typeof DIAGNOSTICS_OPERATION_DEFINITIONS>;
}
