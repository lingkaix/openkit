import type { ModelCatalog } from '@openkit/config-schema';
import { loadModelCatalog } from '../config/model-catalog.js';
import { loadProviderProfiles } from '../config/providers-loader.js';
import { createProviderDiagnostics, type ProviderDiagnosticsSnapshot } from './diagnostics.js';
import { ProviderRegistry } from './registry.js';

/**
 * Provider registry state loaded from one NanoCore data root.
 */
interface DataRootProviderRegistry {
  /** Validated extension metadata captured with this Provider registry. */
  modelCatalog: ModelCatalog;
  /** Redacted provider diagnostics derived from the loaded profiles. */
  providerDiagnostics: ProviderDiagnosticsSnapshot;
  /** Registry containing every valid provider profile loaded from disk. */
  providerRegistry: ProviderRegistry;
}

/**
 * Loads provider profiles, diagnostics, and registry state from a data root.
 *
 * @param dataRoot NanoCore data root containing config/providers/*.provider.jsonc.
 * @returns Provider registry state for runtime app diagnostics.
 */
export function loadProviderRegistryFromDataRoot(dataRoot: string): DataRootProviderRegistry {
  const modelCatalog = loadModelCatalog(dataRoot);
  const providerProfiles = loadProviderProfiles(dataRoot, modelCatalog);

  return {
    modelCatalog,
    providerDiagnostics: createProviderDiagnostics(providerProfiles),
    providerRegistry: new ProviderRegistry(providerProfiles.profiles),
  };
}
