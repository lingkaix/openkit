import { loadProviderProfiles } from '../config/providers-loader.js';
import { createProviderDiagnostics, type ProviderDiagnosticsSnapshot } from './diagnostics.js';
import { ProviderRegistry } from './registry.js';

/**
 * Provider registry state loaded from one NanoCore data root.
 */
interface DataRootProviderRegistry {
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
  const providerProfiles = loadProviderProfiles(dataRoot);

  return {
    providerDiagnostics: createProviderDiagnostics(providerProfiles),
    providerRegistry: new ProviderRegistry(providerProfiles.profiles),
  };
}
