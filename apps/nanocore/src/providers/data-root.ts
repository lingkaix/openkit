import type { OpenKitConfig } from '../config/openkit-config.js';
import type {
  ProviderProfile,
  ProviderProfileDiagnostic,
  ProviderProfileLoadResult,
} from '../config/providers-loader.js';
import { loadProviderProfiles } from '../config/providers-loader.js';
import { isCodexOAuthProviderProfile, readCodexOAuthAccountSlotId } from './codex-oauth-profile.js';
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
 * @param config Optional resolved OpenKit config containing server-level provider instances.
 * @returns Provider registry state for runtime app diagnostics.
 */
export function loadProviderRegistryFromDataRoot(
  dataRoot: string,
  config: OpenKitConfig = {}
): DataRootProviderRegistry {
  const providerProfiles = mergeProviderProfiles(loadProviderProfiles(dataRoot), config);

  return {
    providerDiagnostics: createProviderDiagnostics(providerProfiles),
    providerRegistry: new ProviderRegistry(providerProfiles.profiles),
  };
}

/**
 * Merges server-config provider instances with file-backed provider profiles.
 *
 * @param loadResult Provider profiles loaded from data/config/providers.
 * @param config OpenKit server config that may contain provider instances.
 * @returns Provider profiles with duplicate IDs rejected and diagnosed.
 */
function mergeProviderProfiles(
  loadResult: ProviderProfileLoadResult,
  config: OpenKitConfig
): ProviderProfileLoadResult {
  const serverProfiles: ProviderProfile[] = config.providers ?? [];
  const profiles = [...serverProfiles, ...loadResult.profiles];
  const duplicateIds = findDuplicateIds(profiles);
  const duplicateDiagnostics: ProviderProfileDiagnostic[] = [...duplicateIds].map((id) => ({
    code: 'provider.duplicate_id',
    message: `Duplicate provider instance id "${id}" found across server config and provider profile inputs.`,
    path: 'provider-registry',
    profileId: id,
    severity: 'error',
  }));

  const slotDiagnostics: ProviderProfileDiagnostic[] = [];
  const currentServerProfiles = serverProfiles
    .filter((profile) => !duplicateIds.has(profile.id))
    .map((profile) =>
      applyCodexOAuthSlotDiagnostics(profile, 'provider-registry', slotDiagnostics)
    );
  const currentFileProfiles = loadResult.profiles.filter(
    (profile) => !duplicateIds.has(profile.id)
  );

  return {
    diagnostics: [...loadResult.diagnostics, ...duplicateDiagnostics, ...slotDiagnostics],
    profiles: [...currentServerProfiles, ...currentFileProfiles],
  };
}

/**
 * Applies readiness diagnostics for server-config Codex OAuth providers without explicit slots.
 *
 * @param profile Provider profile to inspect.
 * @param path Diagnostic source path.
 * @param diagnostics Diagnostics collection to append to.
 * @returns Profile with readiness blocked when needed.
 */
function applyCodexOAuthSlotDiagnostics(
  profile: ProviderProfile,
  path: string,
  diagnostics: ProviderProfileDiagnostic[]
): ProviderProfile {
  if (!isCodexOAuthProviderProfile(profile) || readCodexOAuthAccountSlotId(profile)) {
    return profile;
  }

  const message =
    'Codex OAuth provider profiles must set extensions.openkit.codexOAuth.accountSlotId.';

  diagnostics.push({
    code: 'provider.missing_codex_oauth_account_slot',
    message,
    path,
    profileId: profile.id,
    severity: 'error',
  });

  return {
    ...profile,
    readiness: {
      message,
      status: 'blocked',
    },
  };
}

/**
 * Finds provider IDs that appear more than once.
 *
 * @param profiles Provider profiles to inspect.
 * @returns Duplicate provider IDs.
 */
function findDuplicateIds(profiles: ProviderProfile[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const profile of profiles) {
    if (seen.has(profile.id)) {
      duplicates.add(profile.id);
      continue;
    }

    seen.add(profile.id);
  }

  return duplicates;
}
