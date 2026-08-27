import { Buffer } from 'node:buffer';

import {
  type ProviderSubscriptionAccountSlotId,
  ProviderSubscriptionAccountSlotIdSchema,
  type SubscriptionProviderId,
  SubscriptionProviderIdSchema,
} from '@openkit/config-schema';

/** Concrete Vault backend kind supported by NanoCore. */
export type VaultBackendKind = 'encrypted-file';

/** Owner scope recorded with non-secret vault material metadata. */
export type VaultOwnerScope = 'server' | 'user' | 'workspace';

/** Secret material crossing the backend boundary. */
export type VaultSecretMaterial = string | Uint8Array;

/**
 * Converts vault secret material to the UTF-8 string expected by credential consumers.
 *
 * @param material Vault secret material.
 * @returns UTF-8 credential string.
 */
export function vaultSecretMaterialToString(material: VaultSecretMaterial): string {
  return typeof material === 'string' ? material : Buffer.from(material).toString('utf8');
}

/** Stable typed error codes returned by vault backends. */
export type VaultBackendErrorCode =
  | 'backend-unavailable'
  | 'reference-not-found'
  | 'reference-revoked'
  | 'vault-locked'
  | 'version-expired';

/** Health states projected by a vault backend. */
export type VaultBackendHealthState = 'available' | 'locked' | 'unavailable';

/** Redacted backend health projection. */
export interface VaultBackendHealth {
  /** Concrete backend kind. */
  readonly kind: VaultBackendKind;
  /** Current availability and lock state. */
  readonly state: VaultBackendHealthState;
  /** Redacted human-readable diagnostic. */
  readonly diagnostic: string;
}

/** Non-secret metadata carried beside backend material. */
export interface VaultEntryMetadata {
  /** Scope that owns the vault reference metadata. */
  readonly ownerScope: VaultOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId?: string;
  /** User id when ownerScope is user. */
  readonly userId?: string;
  /** Provider subscription account pair for server-owned subscription credentials. */
  readonly providerSubscriptionAccount?: {
    /** Stable provider-scoped account slot id. */
    readonly accountSlotId: ProviderSubscriptionAccountSlotId;
    /** Subscription provider that owns the slot. */
    readonly subscriptionProviderId: SubscriptionProviderId;
  };
}

/** Non-secret inventory row returned by list operations. */
export interface VaultReferenceInventoryEntry extends VaultEntryMetadata {
  /** Stable vault reference id. */
  readonly referenceId: string;
  /** Backend kind that stores this reference's material. */
  readonly backendKind: VaultBackendKind;
  /** Current material version. */
  readonly currentVersion: number;
  /** Number of versions known to the backend. */
  readonly versionCount: number;
  /** True when every version is revoked. */
  readonly revoked: boolean;
  /** ISO timestamp for the latest material update. */
  readonly updatedAt: string;
}

/** Input used to resolve secret material. */
export interface VaultResolveInput {
  /** Stable vault reference id. */
  readonly referenceId: string;
  /** Optional explicit version; current version is used when omitted. */
  readonly version?: number;
}

/** Input used to store initial secret material. */
export interface VaultStoreInput {
  /** Stable vault reference id. */
  readonly referenceId: string;
  /** Secret material to store. */
  readonly material: VaultSecretMaterial;
  /** Non-secret ownership metadata. */
  readonly metadata: VaultEntryMetadata;
}

/** Input used to rotate secret material. */
export interface VaultRotateInput {
  /** Stable vault reference id. */
  readonly referenceId: string;
  /** New secret material version. */
  readonly material: VaultSecretMaterial;
}

/** Input used to revoke a vault reference. */
export interface VaultRevokeInput {
  /** Stable vault reference id. */
  readonly referenceId: string;
}

/** Input used to list non-secret reference metadata. */
export interface VaultListReferencesInput {
  /** Optional owner scope filter. */
  readonly ownerScope?: VaultOwnerScope;
  /** Optional workspace id filter. */
  readonly workspaceId?: string;
  /** Optional user id filter. */
  readonly userId?: string;
}

/** Concrete vault backend contract used by NanoCore callers. */
export interface VaultBackend {
  /** Concrete backend kind. */
  readonly kind: VaultBackendKind;
  /** Returns redacted backend health. */
  health(): VaultBackendHealth;
  /**
   * Resolves one secret material version.
   *
   * @param input Reference and optional version to resolve.
   * @returns Secret material for the requested version.
   * @throws VaultBackendError when the backend cannot resolve the material.
   */
  resolve(input: VaultResolveInput): VaultSecretMaterial;
  /**
   * Stores version 1 material for a new reference.
   *
   * @param input Reference, material, and non-secret metadata.
   * @returns Non-secret inventory metadata for the stored reference.
   * @throws VaultBackendError when the backend cannot store the material.
   */
  store(input: VaultStoreInput): VaultReferenceInventoryEntry;
  /**
   * Rotates one reference to a new current version.
   *
   * @param input Reference and replacement material.
   * @returns Non-secret inventory metadata after rotation.
   * @throws VaultBackendError when the backend cannot rotate the material.
   */
  rotate(input: VaultRotateInput): VaultReferenceInventoryEntry;
  /**
   * Revokes every version for one reference.
   *
   * @param input Reference to revoke.
   * @returns Non-secret inventory metadata after revocation.
   * @throws VaultBackendError when the backend cannot revoke the reference.
   */
  revoke(input: VaultRevokeInput): VaultReferenceInventoryEntry;
  /**
   * Lists non-secret inventory metadata.
   *
   * @param input Optional owner-scope filters.
   * @returns Non-secret reference inventory rows.
   * @throws VaultBackendError when the backend cannot list references.
   */
  listReferences(input?: VaultListReferencesInput): VaultReferenceInventoryEntry[];
}

/** Error raised by vault backends without carrying secret material. */
export class VaultBackendError extends Error {
  /** Stable typed error code. */
  public readonly code: VaultBackendErrorCode;

  /**
   * Creates a typed redacted vault backend error.
   *
   * @param code Stable vault backend error code.
   * @param message Redacted human-readable message.
   */
  public constructor(code: VaultBackendErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'VaultBackendError';
    this.code = code;
  }
}

/**
 * Verifies that non-secret entry metadata matches its declared owner scope.
 *
 * @param metadata Metadata to validate before storing material.
 * @throws VaultBackendError when scope-specific ids are inconsistent.
 */
export function assertVaultEntryMetadata(metadata: VaultEntryMetadata): void {
  const value: unknown = metadata;

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VaultBackendError(
      'backend-unavailable',
      'Vault entry metadata does not match its owner scope.'
    );
  }

  const candidate = value as Partial<VaultEntryMetadata> & Record<string, unknown>;
  const pairValue: unknown = candidate.providerSubscriptionAccount;
  const pair =
    typeof pairValue === 'object' && pairValue !== null && !Array.isArray(pairValue)
      ? (pairValue as Record<string, unknown>)
      : undefined;
  const allowedKeys = [
    'ownerScope',
    ...(candidate.ownerScope === 'workspace' ? ['workspaceId'] : []),
    ...(candidate.ownerScope === 'user' ? ['userId'] : []),
    ...(pairValue !== undefined ? ['providerSubscriptionAccount'] : []),
  ].sort();
  const actualKeys = Object.keys(candidate).sort();
  const validPair =
    pairValue === undefined ||
    (pair !== undefined &&
      candidate.ownerScope === 'server' &&
      Object.keys(pair).sort().join(',') === 'accountSlotId,subscriptionProviderId' &&
      typeof pair.accountSlotId === 'string' &&
      ProviderSubscriptionAccountSlotIdSchema.safeParse(pair.accountSlotId).success &&
      typeof pair.subscriptionProviderId === 'string' &&
      SubscriptionProviderIdSchema.safeParse(pair.subscriptionProviderId).success);
  const valid =
    validPair &&
    actualKeys.length === allowedKeys.length &&
    actualKeys.every((key, index) => key === allowedKeys[index]) &&
    ((candidate.ownerScope === 'workspace' &&
      typeof candidate.workspaceId === 'string' &&
      candidate.workspaceId.length > 0) ||
      (candidate.ownerScope === 'user' &&
        typeof candidate.userId === 'string' &&
        candidate.userId.length > 0) ||
      candidate.ownerScope === 'server');

  if (!valid) {
    throw new VaultBackendError(
      'backend-unavailable',
      'Vault entry metadata does not match its owner scope.'
    );
  }
}

/** Input used to create a locked backend projection. */
export interface CreateLockedVaultBackendInput {
  /** Concrete backend kind. */
  readonly kind: VaultBackendKind;
  /** Redacted lock diagnostic. */
  readonly diagnostic: string;
}

/**
 * Creates a backend projection that truthfully reports locked state.
 *
 * @param input Locked backend kind and diagnostic.
 * @returns Vault backend whose material operations fail with vault-locked.
 */
export function createLockedVaultBackend(input: CreateLockedVaultBackendInput): VaultBackend {
  return new LockedVaultBackend(input.kind, input.diagnostic);
}

/** Locked backend implementation used before a concrete backend is unlocked. */
class LockedVaultBackend implements VaultBackend {
  public readonly kind: VaultBackendKind;

  private readonly diagnostic: string;

  /**
   * Creates a locked backend implementation.
   *
   * @param kind Concrete backend kind.
   * @param diagnostic Redacted lock diagnostic.
   */
  public constructor(kind: VaultBackendKind, diagnostic: string) {
    this.kind = kind;
    this.diagnostic = diagnostic;
  }

  /**
   * Returns the locked health projection.
   *
   * @returns Redacted locked backend health.
   */
  public health(): VaultBackendHealth {
    return {
      diagnostic: this.diagnostic,
      kind: this.kind,
      state: 'locked',
    };
  }

  /**
   * Fails secret resolution while the backend is locked.
   *
   * @param _input Reference and optional version to resolve.
   * @throws VaultBackendError because locked backends cannot resolve material.
   */
  public resolve(_input: VaultResolveInput): VaultSecretMaterial {
    throw this.lockedError();
  }

  /**
   * Fails material storage while the backend is locked.
   *
   * @param _input Reference, material, and non-secret metadata.
   * @throws VaultBackendError because locked backends cannot store material.
   */
  public store(_input: VaultStoreInput): VaultReferenceInventoryEntry {
    throw this.lockedError();
  }

  /**
   * Fails material rotation while the backend is locked.
   *
   * @param _input Reference and replacement material.
   * @throws VaultBackendError because locked backends cannot rotate material.
   */
  public rotate(_input: VaultRotateInput): VaultReferenceInventoryEntry {
    throw this.lockedError();
  }

  /**
   * Fails reference revocation while the backend is locked.
   *
   * @param _input Reference to revoke.
   * @throws VaultBackendError because locked backends cannot revoke references.
   */
  public revoke(_input: VaultRevokeInput): VaultReferenceInventoryEntry {
    throw this.lockedError();
  }

  /**
   * Fails reference listing while the backend is locked.
   *
   * @param _input Optional owner-scope filters.
   * @throws VaultBackendError because locked backends cannot list references.
   */
  public listReferences(_input: VaultListReferencesInput = {}): VaultReferenceInventoryEntry[] {
    throw this.lockedError();
  }

  /**
   * Builds the shared locked-state error.
   *
   * @returns Typed locked vault backend error.
   */
  private lockedError(): VaultBackendError {
    return new VaultBackendError('vault-locked', this.diagnostic);
  }
}
