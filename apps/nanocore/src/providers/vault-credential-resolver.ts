import { OpenAICompatibleProviderError } from '../llm/openai-compatible-client.js';
import type { CoreDb } from '../storage/db.js';
import {
  type VaultBackend,
  VaultBackendError,
  vaultSecretMaterialToString,
} from '../vault/vault-backend.js';
import { getVaultReference, revokeVaultReference } from '../vault/vault-references.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';
import type { ProviderCredentialResolver } from './registry.js';

/** Input used to create a vault-backed provider credential resolver. */
export interface CreateVaultProviderCredentialResolverInput {
  /** Core database used to write non-secret vault use records. */
  readonly coreDb: CoreDb;
  /** Returns the current vault backend projection. */
  readonly vaultBackend: () => VaultBackend;
  /** Optional resolver attempted before vault references. */
  readonly fallback?: ProviderCredentialResolver;
  /** Optional deterministic clock for audited use records. */
  readonly now?: () => string;
  /** Optional deterministic use id factory for audited use records. */
  readonly createUseId?: () => string;
}

/**
 * Creates a provider credential resolver that supports audited vault references.
 *
 * @param input Database, backend factory, and optional deterministic hooks.
 * @returns Provider credential resolver for runtime provider profiles.
 */
export function createVaultProviderCredentialResolver(
  input: CreateVaultProviderCredentialResolverInput
): ProviderCredentialResolver {
  return (secretRef) => {
    if (input.fallback) {
      const fallbackValue = input.fallback(secretRef);

      if (fallbackValue != null) {
        return fallbackValue;
      }
    }

    const referenceId = readVaultReferenceId(secretRef);

    if (!referenceId) {
      return null;
    }

    try {
      const auditedBackend = createVaultUseAuditedBackend({
        backend: input.vaultBackend(),
        db: input.coreDb,
        ownerScope: 'server',
        resolvingPath: 'provider',
        ...(input.now ? { now: input.now } : {}),
        ...(input.createUseId ? { createUseId: input.createUseId } : {}),
      });

      return vaultSecretMaterialToString(auditedBackend.resolve({ referenceId }));
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw new OpenAICompatibleProviderError({
          code: error.code,
          message: error.message,
          status: error.code === 'vault-locked' ? 423 : 503,
          type: 'provider_credential_error',
        });
      }

      throw error;
    }
  };
}

/**
 * Reads a vault reference id from a supported provider credential reference.
 *
 * @param secretRef Provider credential reference.
 * @returns Vault reference id when the reference uses vault://, otherwise null.
 */
export function readVaultReferenceId(secretRef: string): string | null {
  const prefix = 'vault://';

  if (!secretRef.startsWith(prefix)) {
    return null;
  }

  const referenceId = secretRef.slice(prefix.length);

  return referenceId.length > 0 ? referenceId : null;
}

/**
 * Revokes one exact server key reference before its Provider profile is removed.
 * Backend material and the Core cascade are separate effects; failure requires inspection.
 *
 * @param input Existing Core and current backend dependencies.
 * @param secretRef Exact authored Vault reference; external references cannot be revoked here.
 * @throws VaultBackendError with redacted failure when authority or either effect fails.
 */
export function revokeVaultProviderCredential(
  input: Pick<CreateVaultProviderCredentialResolverInput, 'coreDb' | 'vaultBackend'>,
  secretRef: string
): void {
  const referenceId = readVaultReferenceId(secretRef);
  if (!referenceId)
    throw new VaultBackendError(
      'backend-unavailable',
      'Provider secret reference cannot be revoked through Vault.'
    );
  const backend = input.vaultBackend();
  const health = backend.health().state;
  if (health !== 'available')
    throw new VaultBackendError(
      health === 'locked' ? 'vault-locked' : 'backend-unavailable',
      'Vault backend is not available.'
    );
  try {
    const reference = getVaultReference(input.coreDb, referenceId);
    const inventory = backend
      .listReferences({ ownerScope: 'server' })
      .find((entry) => entry.referenceId === referenceId);
    if (
      !reference ||
      reference.ownerScope !== 'server' ||
      reference.workspaceId !== null ||
      reference.userId !== null ||
      reference.status !== 'active' ||
      reference.secretKind !== 'provider-api-key' ||
      !inventory ||
      inventory.revoked ||
      inventory.currentVersion !== reference.currentVersion ||
      inventory.backendKind !== reference.backendKind ||
      reference.backendKind !== backend.kind ||
      inventory.workspaceId !== undefined ||
      inventory.userId !== undefined ||
      inventory.providerSubscriptionAccount !== undefined ||
      reference.backendLocator !== `${backend.kind}://server/vault/${referenceId}`
    ) {
      throw new Error('Vault storage requires inspection.');
    }
    backend.revoke({ referenceId });
    revokeVaultReference(input.coreDb, { referenceId });
  } catch {
    throw new VaultBackendError(
      'backend-unavailable',
      'Vault mutation failed; inspect inventory before a new request.'
    );
  }
}
