import { randomUUID } from 'node:crypto';

import { recordServerAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { VaultUseOwnerScope, VaultUseResolvingPath } from '../storage/schema/index.js';
import {
  type VaultBackend,
  VaultBackendError,
  type VaultListReferencesInput,
  type VaultReferenceInventoryEntry,
  type VaultResolveInput,
  type VaultRevokeInput,
  type VaultRotateInput,
  type VaultSecretMaterial,
  type VaultStoreInput,
} from './vault-backend.js';
import { createVaultUseRecord } from './vault-use-records.js';

/** Database handle that can store vault use audit records. */
type VaultUseAuditDb = CoreDb | WorkspaceDb;

/** Input used to create one audited vault backend wrapper. */
export interface CreateVaultUseAuditedBackendInput {
  /** Backend that owns secret material operations. */
  readonly backend: VaultBackend;
  /** Scope-owning database that stores non-secret use records. */
  readonly db: VaultUseAuditDb;
  /** Scope that owns the use record. */
  readonly ownerScope: VaultUseOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId?: string;
  /** Path that triggered secret resolution. */
  readonly resolvingPath: VaultUseResolvingPath;
  /** Vault grant id when grant-based. */
  readonly grantId?: string;
  /** Injection plan id when plan-based. */
  readonly planId?: string;
  /** Injection receipt id when available. */
  readonly receiptId?: string;
  /** AgentSession id when available. */
  readonly agentSessionId?: string;
  /** Capability call id when available. */
  readonly capabilityCallId?: string;
  /** Linked audit event id when available. */
  readonly auditEventId?: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Optional deterministic use id factory. */
  readonly createUseId?: () => string;
}

/**
 * Wraps a vault backend so every resolve attempt emits a non-secret VaultUse record.
 *
 * @param input Backend, database, scope, and resolution metadata.
 * @returns Vault backend with audited resolve behavior.
 */
export function createVaultUseAuditedBackend(
  input: CreateVaultUseAuditedBackendInput
): VaultBackend {
  return new VaultUseAuditedBackend(input);
}

/** Vault backend wrapper that records resolve attempts. */
class VaultUseAuditedBackend implements VaultBackend {
  public readonly kind: VaultBackend['kind'];

  private readonly input: CreateVaultUseAuditedBackendInput;

  /**
   * Creates one audited backend wrapper.
   *
   * @param input Backend, database, scope, and resolution metadata.
   */
  public constructor(input: CreateVaultUseAuditedBackendInput) {
    this.kind = input.backend.kind;
    this.input = input;
  }

  /**
   * Returns delegated backend health.
   *
   * @returns Redacted backend health.
   */
  public health(): ReturnType<VaultBackend['health']> {
    return this.input.backend.health();
  }

  /**
   * Resolves material and records a VaultUse row for success or typed failure.
   *
   * @param resolveInput Reference and optional version to resolve.
   * @returns Secret material from the wrapped backend.
   * @throws VaultBackendError when the wrapped backend cannot resolve material.
   */
  public resolve(resolveInput: VaultResolveInput): VaultSecretMaterial {
    try {
      this.assertResolutionScope(resolveInput.referenceId);
      const material = this.input.backend.resolve(resolveInput);
      this.recordUse(resolveInput, 'succeeded', null);
      return material;
    } catch (error) {
      if (error instanceof VaultBackendError) {
        this.recordUse(resolveInput, 'failed', error.code);
      }

      throw error;
    }
  }

  /**
   * Delegates initial material storage to the wrapped backend.
   *
   * @param storeInput Reference, material, and non-secret metadata.
   * @returns Non-secret inventory metadata.
   */
  public store(storeInput: VaultStoreInput): VaultReferenceInventoryEntry {
    return this.input.backend.store(storeInput);
  }

  /**
   * Delegates material rotation to the wrapped backend.
   *
   * @param rotateInput Reference and replacement material.
   * @returns Non-secret inventory metadata.
   */
  public rotate(rotateInput: VaultRotateInput): VaultReferenceInventoryEntry {
    return this.input.backend.rotate(rotateInput);
  }

  /**
   * Delegates reference revocation to the wrapped backend.
   *
   * @param revokeInput Reference to revoke.
   * @returns Non-secret inventory metadata.
   */
  public revoke(revokeInput: VaultRevokeInput): VaultReferenceInventoryEntry {
    return this.input.backend.revoke(revokeInput);
  }

  /**
   * Delegates inventory listing to the wrapped backend.
   *
   * @param listInput Optional owner-scope filters.
   * @returns Non-secret inventory metadata rows.
   */
  public listReferences(listInput: VaultListReferencesInput = {}): VaultReferenceInventoryEntry[] {
    return this.input.backend.listReferences(listInput);
  }

  /**
   * Rejects implicit cross-scope secret resolution before material leaves the backend.
   *
   * @param referenceId Vault reference id requested by the caller.
   * @throws VaultBackendError when the stored owner scope does not match this wrapper scope.
   */
  private assertResolutionScope(referenceId: string): void {
    const entry = this.input.backend
      .listReferences()
      .find((candidate) => candidate.referenceId === referenceId);

    if (!entry) {
      return;
    }

    const matches =
      entry.ownerScope === this.input.ownerScope &&
      (entry.ownerScope !== 'workspace' || entry.workspaceId === this.input.workspaceId);

    if (!matches && !this.input.grantId) {
      throw new VaultBackendError(
        'backend-unavailable',
        'Vault reference scope does not match resolution scope.'
      );
    }
  }

  /**
   * Records one non-secret use row.
   *
   * @param resolveInput Reference and optional version resolved.
   * @param outcome Resolve outcome.
   * @param failureCode Failure code for failed attempts.
   */
  private recordUse(
    resolveInput: VaultResolveInput,
    outcome: 'succeeded' | 'failed',
    failureCode: string | null
  ): void {
    const auditEventId = this.auditEventId();

    createVaultUseRecord(this.input.db, {
      agentSessionId: this.input.agentSessionId ?? null,
      auditEventId,
      backendKind: this.kind,
      capabilityCallId: this.input.capabilityCallId ?? null,
      failureCode,
      grantId: this.input.grantId ?? null,
      materialVersion: this.materialVersion(resolveInput, outcome),
      outcome,
      ownerScope: this.input.ownerScope,
      planId: this.input.planId ?? null,
      receiptId: this.input.receiptId ?? null,
      resolvingPath: this.input.resolvingPath,
      usedAt: (this.input.now ?? (() => new Date().toISOString()))(),
      useId: (this.input.createUseId ?? randomUUID)(),
      vaultReferenceId: resolveInput.referenceId,
      workspaceId: this.input.workspaceId ?? null,
    });

    if (!this.input.auditEventId && auditEventId) {
      const event = {
        action: 'vault.resolve',
        agentSessionId: this.input.agentSessionId ?? null,
        auditEventId,
        capabilityCallId: this.input.capabilityCallId ?? null,
        category: 'system' as const,
        errorCode: failureCode,
        outcome,
        resource: `vault:${resolveInput.referenceId}`,
        severity: outcome === 'succeeded' ? ('info' as const) : ('error' as const),
        summary:
          outcome === 'succeeded'
            ? 'Vault reference resolved.'
            : 'Vault reference resolution failed.',
        vaultGrantId: this.input.grantId ?? null,
      };

      if (isWorkspaceDb(this.input.db)) {
        recordWorkspaceAuditEvent({
          ...event,
          workspaceDb: this.input.db,
          workspaceId: this.input.workspaceId ?? this.input.db.workspaceId,
        });
      } else {
        recordServerAuditEvent({
          ...event,
          coreDb: this.input.db,
        });
      }
    }
  }

  /**
   * Returns the linked audit event id for this use record.
   *
   * @returns Explicit or generated audit event id.
   */
  private auditEventId(): string | null {
    if (this.input.auditEventId) {
      return this.input.auditEventId;
    }

    return `aud_${randomUUID()}`;
  }

  /**
   * Returns the resolved material version when known.
   *
   * @param resolveInput Reference and optional version resolved.
   * @param outcome Resolve outcome.
   * @returns Explicit version, current inventory version, or null for unknown failed references.
   */
  private materialVersion(
    resolveInput: VaultResolveInput,
    outcome: 'succeeded' | 'failed'
  ): number | null {
    if (resolveInput.version != null) {
      return resolveInput.version;
    }

    if (outcome === 'failed') {
      return null;
    }

    return (
      this.input.backend
        .listReferences()
        .find((entry) => entry.referenceId === resolveInput.referenceId)?.currentVersion ?? null
    );
  }
}

/**
 * Checks whether a vault-use database handle is workspace-scoped.
 *
 * @param db Database handle.
 * @returns Whether the handle owns a workspace database.
 */
function isWorkspaceDb(db: VaultUseAuditDb): db is WorkspaceDb {
  return 'scope' in db && db.scope === 'workspace';
}
