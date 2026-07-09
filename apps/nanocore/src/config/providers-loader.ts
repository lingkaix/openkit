import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ProviderProfile, ProviderProfileSchema } from '@openkit/config-schema';
import { z } from 'zod';
import {
  isCodexOAuthProviderProfile,
  readCodexOAuthAccountSlotId,
} from '../providers/codex-oauth-profile.js';
import { parseJsoncObject } from './jsonc.js';

export type { ProviderProfile };
export { ProviderProfileSchema };

/**
 * Provider loader diagnostic.
 */
export interface ProviderProfileDiagnostic {
  /** Stable diagnostic code. */
  code:
    | 'provider.duplicate_id'
    | 'provider.invalid_profile'
    | 'provider.missing_codex_oauth_account_slot'
    | 'provider.unknown_required_extension';
  /** File path that produced the diagnostic. */
  path: string;
  /** Profile id, when it could be read. */
  profileId?: string | undefined;
  /** Human-readable diagnostic message. */
  message: string;
  /** Diagnostic severity. */
  severity: 'error';
}

/**
 * Provider profile load result.
 */
export interface ProviderProfileLoadResult {
  /** Loaded provider profiles. */
  profiles: ProviderProfile[];
  /** Blocking diagnostics discovered while loading profiles. */
  diagnostics: ProviderProfileDiagnostic[];
}

/**
 * Loads every provider profile under data/config/providers.
 *
 * @param dataRoot Data root to read.
 * @returns Loaded profiles and diagnostics.
 */
export function loadProviderProfiles(dataRoot: string): ProviderProfileLoadResult {
  const providersRoot = join(dataRoot, 'config', 'providers');
  const result: ProviderProfileLoadResult = { profiles: [], diagnostics: [] };

  if (!existsSync(providersRoot)) {
    return result;
  }

  for (const fileName of readdirSync(providersRoot).sort()) {
    if (!fileName.endsWith('.provider.jsonc')) {
      continue;
    }

    const path = join(providersRoot, fileName);
    const parsed = parseJsoncObject(readFileSync(path, 'utf8'), path);
    const profileResult = ProviderProfileSchema.safeParse(parsed);

    if (!profileResult.success) {
      result.diagnostics.push({
        code: 'provider.invalid_profile',
        message: z.prettifyError(profileResult.error),
        path,
        profileId: readProfileId(parsed),
        severity: 'error',
      });
      continue;
    }

    const profile = applyRequiredExtensionDiagnostics(profileResult.data, path, result.diagnostics);

    result.profiles.push(applyCodexOAuthSlotDiagnostics(profile, path, result.diagnostics));
  }

  return result;
}

/**
 * Applies readiness diagnostics for Codex OAuth profiles without explicit account slots.
 *
 * @param profile Parsed provider profile.
 * @param path Source file path.
 * @param diagnostics Diagnostics collection to append to.
 * @returns Profile with readiness blocked when a Codex OAuth slot is missing.
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
 * Applies readiness blocking diagnostics for unknown required extensions.
 *
 * @param profile Parsed provider profile.
 * @param path Source file path.
 * @param diagnostics Diagnostics collection to append to.
 * @returns Profile with readiness blocked when needed.
 */
function applyRequiredExtensionDiagnostics(
  profile: ProviderProfile,
  path: string,
  diagnostics: ProviderProfileDiagnostic[]
): ProviderProfile {
  const requiredExtension = Object.entries(profile.extensions ?? {}).find(([, value]) =>
    isRequiredExtension(value)
  );

  if (!requiredExtension) {
    return profile;
  }

  const [name] = requiredExtension;
  const message = `Unknown required extension section: ${name}`;

  diagnostics.push({
    code: 'provider.unknown_required_extension',
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
 * Checks whether an extension declares itself required.
 *
 * @param value Extension payload.
 * @returns True when the extension is required.
 */
function isRequiredExtension(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'required' in value &&
    (value as { required?: unknown }).required === true
  );
}

/**
 * Reads a profile id from an arbitrary parsed object.
 *
 * @param value Parsed profile candidate.
 * @returns Profile id, when present.
 */
function readProfileId(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : undefined;
}
