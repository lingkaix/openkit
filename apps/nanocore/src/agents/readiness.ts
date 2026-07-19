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

/**
 * Checks the sole degraded admission case for a manifest-owned runtime credential.
 *
 * @param manifest Agent manifest to evaluate.
 * @param providerRegistry Provider registry used to resolve the selected provider profile.
 * @param dependencies Optional provider credential resolver.
 * @returns True only when turn-scoped AEP resolution owns an unresolved runtime-env credential.
 */
export function qualifiesForDeferredManifestCredentialAdmission(
  manifest: AgentManifest,
  providerRegistry: ProviderRegistry,
  dependencies: AgentReadinessDependencies = {}
): boolean {
  const providerRef = manifest.provider?.ref;
  const provider = providerRef ? providerRegistry.get(providerRef) : null;
  const credentialDeclarations = manifest.sandbox?.credentialDeclarations ?? [];

  if (
    !providerRef ||
    !provider ||
    provider.kind !== 'direct' ||
    provider.secretRef ||
    provider.readiness?.status !== 'ready' ||
    credentialDeclarations.length !== 1 ||
    credentialDeclarations[0]?.visibility !== 'runtime-env' ||
    !manifest.sandbox?.network.length
  ) {
    return false;
  }

  return (
    providerRegistry.hasResolvableCredentials(
      providerRef,
      dependencies.providerCredentialResolver
    ) === false
  );
}

/**
 * Checks whether computed readiness permits worker launch.
 *
 * @param readiness Computed readiness result.
 * @param manifest Selected agent manifest.
 * @param providerRegistry Provider registry used by readiness computation.
 * @param dependencies Optional provider credential resolver.
 * @returns True for ready agents and the sole bounded deferred-credential case.
 */
export function isAgentLaunchable(
  readiness: AgentReadiness,
  manifest: AgentManifest,
  providerRegistry: ProviderRegistry,
  dependencies: AgentReadinessDependencies = {}
): boolean {
  return (
    readiness.status === 'ready' ||
    (readiness.status === 'degraded' &&
      qualifiesForDeferredManifestCredentialAdmission(manifest, providerRegistry, dependencies))
  );
}

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
  const declaredReadiness = manifest.readiness;
  if (
    declaredReadiness?.status === 'disabled' ||
    declaredReadiness?.status === 'blocked' ||
    declaredReadiness?.status === 'unknown'
  ) {
    return {
      reasons: declaredReadiness.message
        ? [declaredReadiness.message]
        : declaredReadiness.status === 'disabled'
          ? ['Agent is disabled.']
          : [],
      status: declaredReadiness.status,
    };
  }

  if (manifest.provider?.ref) {
    const provider = providerRegistry.get(manifest.provider.ref);

    if (!provider) {
      return {
        reasons: [`Provider profile ${manifest.provider.ref} is missing.`],
        status: 'blocked',
      };
    }

    if (provider.readiness && provider.readiness.status !== 'ready') {
      return {
        reasons: provider.readiness.message ? [provider.readiness.message] : [],
        status: provider.readiness.status,
      };
    }

    const credentialState = providerRegistry.hasResolvableCredentials(
      manifest.provider.ref,
      dependencies.providerCredentialResolver
    );

    if (credentialState === false) {
      if (
        qualifiesForDeferredManifestCredentialAdmission(manifest, providerRegistry, dependencies)
      ) {
        return {
          reasons: [
            `Provider ${provider.id} defers manifest-owned worker credential validation to turn-scoped AEP resolution.`,
          ],
          status: 'degraded',
        };
      }

      return {
        reasons: [`Provider ${provider.id} is missing credentials.`],
        status: 'blocked',
      };
    }
  }

  if (declaredReadiness?.status === 'ready') {
    return { reasons: [], status: 'ready' };
  }

  if (declaredReadiness?.status) {
    return {
      reasons: declaredReadiness.message ? [declaredReadiness.message] : [],
      status: declaredReadiness.status,
    };
  }

  return { reasons: [], status: 'ready' };
}
