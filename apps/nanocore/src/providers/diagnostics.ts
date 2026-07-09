import type {
  ProviderProfileDiagnostic,
  ProviderProfileLoadResult,
} from '../config/providers-loader.js';
import { ProviderRegistry, type ProviderRegistrySummary } from './registry.js';

/**
 * Provider diagnostics code produced after loading provider profiles.
 */
export type ProviderDiagnosticCode = ProviderProfileDiagnostic['code'];

/**
 * Provider diagnostics status.
 */
export type ProviderDiagnosticStatus = 'ready' | 'degraded' | 'blocked' | 'disabled' | 'unknown';

/**
 * Redacted provider diagnostic summary.
 */
export interface ProviderDiagnosticSummary {
  /** Stable diagnostic code. */
  code: ProviderDiagnosticCode;
  /** Human-readable diagnostic message. */
  message: string;
  /** Provider id associated with the diagnostic, when known. */
  profileId?: string;
  /** Redacted source file path. */
  source: string;
  /** Readiness status represented by this diagnostic. */
  status: ProviderDiagnosticStatus;
}

/**
 * Provider diagnostics payload for app diagnostics.
 */
export interface ProviderDiagnosticsSnapshot {
  /** Redacted provider profile summaries. */
  redactedSnapshot: ProviderRegistrySummary[];
  /** Blocking or degraded diagnostics. */
  summaries: ProviderDiagnosticSummary[];
}

/**
 * Produces readiness diagnostics and a redacted provider snapshot.
 *
 * @param loadResult Provider profile load result.
 * @returns Redacted diagnostics payload.
 */
export function createProviderDiagnostics(
  loadResult: ProviderProfileLoadResult
): ProviderDiagnosticsSnapshot {
  const registry = new ProviderRegistry(loadResult.profiles);
  const summaries: ProviderDiagnosticSummary[] = [
    ...loadResult.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.profileId ? { profileId: diagnostic.profileId } : {}),
      source: redactPath(diagnostic.path),
      status: 'blocked' as const,
    })),
  ];

  return {
    redactedSnapshot: registry.summarize(),
    summaries,
  };
}

/**
 * Removes local directory details from a diagnostics source path.
 *
 * @param path Source path.
 * @returns Redacted source path.
 */
function redactPath(path: string): string {
  const marker = 'config/providers/';
  const index = path.lastIndexOf(marker);

  return index >= 0 ? path.slice(index) : (path.split('/').at(-1) ?? path);
}
