import type { ProviderCredentialResolver, ProviderRegistry } from '../providers/registry.js';
import type { AgentManifest } from './manifest.js';

/**
 * Agent readiness status.
 */
export type AgentReadinessStatus = 'ready' | 'degraded' | 'blocked' | 'disabled' | 'unknown';

/**
 * Agent readiness result with operator-facing reasons.
 */
export interface AgentReadiness {
  /** Computed readiness status. */
  status: AgentReadinessStatus;
  /** Human-readable reasons explaining non-ready or explicitly declared states. */
  reasons: string[];
}

/**
 * Injectable readiness dependencies for tests and future runtime probes.
 */
export interface AgentReadinessDependencies {
  /** Resolver used to prove provider credential references are usable. */
  providerCredentialResolver?: ProviderCredentialResolver;
}

const SUPPORTED_MANIFEST_VERSION = '0.0.2';

/**
 * Computes agent readiness from manifest dependencies and provider registry state.
 *
 * @param manifest Agent manifest to evaluate.
 * @param providerRegistry Provider registry used to resolve provider dependencies.
 * @param dependencies Optional injectable dependency checks.
 * @returns Agent readiness result.
 */
export function computeReadiness(
  manifest: AgentManifest,
  providerRegistry: ProviderRegistry,
  dependencies: AgentReadinessDependencies = {}
): AgentReadiness {
  if (manifest.readiness?.status === 'disabled') {
    return {
      reasons: [manifest.readiness.message ?? 'Agent is disabled.'],
      status: 'disabled',
    };
  }

  if (manifest.version !== SUPPORTED_MANIFEST_VERSION) {
    return {
      reasons: [`Unsupported agent manifest version: ${manifest.version}.`],
      status: 'blocked',
    };
  }

  if (manifest.providerRef) {
    const provider = providerRegistry.get(manifest.providerRef);
    const credentialState = providerRegistry.hasResolvableCredentials(
      manifest.providerRef,
      dependencies.providerCredentialResolver
    );

    if (!provider) {
      return {
        reasons: [`Provider profile ${manifest.providerRef} is missing.`],
        status: 'blocked',
      };
    }

    if (credentialState === false) {
      return {
        reasons: [`Provider ${provider.id} is missing credentials.`],
        status: 'degraded',
      };
    }
  }

  if (manifest.readiness?.status === 'ready') {
    return { reasons: [], status: 'ready' };
  }

  if (manifest.readiness?.status) {
    return {
      reasons: manifest.readiness.message ? [manifest.readiness.message] : [],
      status: manifest.readiness.status,
    };
  }

  return { reasons: [], status: 'ready' };
}
