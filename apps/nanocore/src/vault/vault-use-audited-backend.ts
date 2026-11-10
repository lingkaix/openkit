import { isDeepStrictEqual } from 'node:util';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { type ActorRef, allocateEntityId } from '@openkit/protocol';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { requireAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { assertCurrentWorkerCredentialAuthority } from '../runtime/worker-credential-authority.js';
import { openControlStoreProductReadHandle } from '../storage/control-store-product-records.js';
import { bindCoreSqlite, type CoreDb, type WorkspaceDb } from '../storage/db.js';
import { coreDbPath } from '../storage/fs-layout.js';
import type { VaultUseOwnerScope, VaultUseResolvingPath } from '../storage/schema/index.js';
import {
  getVaultGrant,
  getVaultInjectionPlan,
  getVaultReference,
} from '../storage/vault-native-codecs.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { recordVaultAuditEvent } from './vault-admin-audit-events.js';
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
  /** Consuming audience for the linked Audit; the Server VaultUse itself remains Server-owned. */
  readonly consumerWorkspaceId?: string;
  /** Initiating human retained by the admitted consuming package. */
  readonly actor?: ActorRef;
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

/** The existing material backend stays synchronous; only the evidence-owning resolution waits for native commits. */
export interface AuditedVaultBackend extends Omit<VaultBackend, 'resolve'> {
  /** Resolves private material only after every required Use and Audit acknowledgement. */
  resolve(input: VaultResolveInput): Promise<VaultSecretMaterial>;
}

/**
 * Wraps a vault backend so every resolve attempt emits a non-secret VaultUse record.
 *
 * @param input Backend, database, scope, and resolution metadata.
 * @returns Vault backend with audited resolve behavior.
 */
export function createVaultUseAuditedBackend(
  input: CreateVaultUseAuditedBackendInput
): AuditedVaultBackend {
  return new VaultUseAuditedBackend(input);
}

/** Vault backend wrapper that records resolve attempts. */
class VaultUseAuditedBackend implements AuditedVaultBackend {
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
  public async resolve(resolveInput: VaultResolveInput): Promise<VaultSecretMaterial> {
    let version: number;
    let material: VaultSecretMaterial;
    try {
      const entry = this.assertResolutionScope(resolveInput.referenceId, resolveInput.version);
      version = resolveInput.version ?? entry.currentVersion;
      material = this.input.backend.resolve({ ...resolveInput, version });
    } catch (error) {
      if (error instanceof VaultBackendError)
        await this.recordUse(resolveInput, 'failed', error.code, resolveInput.version ?? null);
      throw error;
    }
    // Evidence failure is a storage failure, never another backend resolution failure or an automatic second Use.
    await this.recordUse(resolveInput, 'succeeded', null, version);
    // Native evidence waits cannot retain authority to a locked, revoked or expired generation.
    // The synchronous backend owns that validation; do not recurse through audited resolution.
    const current = this.assertResolutionScope(resolveInput.referenceId, resolveInput.version);
    if (resolveInput.version === undefined && current.currentVersion !== version)
      throw new VaultBackendError('version-expired', 'Vault material generation changed.');
    this.input.backend.assertResolutionCurrent({ ...resolveInput, version });
    return material;
  }

  /** Revalidates this wrapper's addressed scope and backend version without resolving material. */
  public assertResolutionCurrent(resolveInput: VaultResolveInput): void {
    this.assertResolutionScope(resolveInput.referenceId, resolveInput.version);
    this.input.backend.assertResolutionCurrent(resolveInput);
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
   * @param listInput Optional exact reference and owner-scope filters.
   * @returns Non-secret inventory metadata rows.
   */
  public listReferences(listInput: VaultListReferencesInput = {}): VaultReferenceInventoryEntry[] {
    return this.input.backend.listReferences(listInput);
  }

  /**
   * Rejects implicit cross-scope secret resolution before material leaves the backend.
   *
   * @param referenceId Vault reference id requested by the caller.
   * @returns Authenticated addressed inventory for the exact admitted scope.
   * @throws VaultBackendError when the stored owner scope does not match this wrapper scope.
   */
  private assertResolutionScope(
    referenceId: string,
    requestedVersion?: number
  ): VaultReferenceInventoryEntry {
    const entry = this.input.backend
      .listReferences({ referenceId })
      .find((candidate) => candidate.referenceId === referenceId);

    if (!entry) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }

    const matches =
      entry.ownerScope === this.input.ownerScope &&
      (entry.ownerScope !== 'workspace' || entry.workspaceId === this.input.workspaceId);

    if (!matches) {
      this.assertUserLoginUse(entry, requestedVersion);
    }
    return entry;
  }

  /** Validates the one reviewed cross-scope Login join; a grant id or ownership alone is never authority. */
  private assertUserLoginUse(entry: VaultReferenceInventoryEntry, requestedVersion?: number): void {
    const input = this.input;
    const refuse: () => never = () => {
      throw new VaultBackendError(
        'backend-unavailable',
        'Vault reference scope does not match resolution scope.'
      );
    };
    if (
      entry.ownerScope !== 'user' ||
      input.ownerScope !== 'workspace' ||
      input.db.scope !== 'workspace' ||
      input.workspaceId !== input.db.workspaceId ||
      !input.actor ||
      !input.grantId
    )
      refuse();

    // Borrow no writable initializer or ambient singleton. The existing physical reader
    // checks the exact Core file under the consuming database's admitted data root.
    const reader = openControlStoreProductReadHandle(coreDbPath(input.db.dataRoot), {
      kind: 'server',
    });
    try {
      const coreDb = bindCoreSqlite(reader.sqlite, input.db.dataRoot);
      const grant = getVaultGrant(coreDb, input.grantId);
      const reference = getVaultReference(coreDb, entry.referenceId);
      const effectAuthority =
        grant?.issuance === 'target' &&
        (grant.approvalId === null ||
          (isTargetIssuedEffectAuthority(grant.approvalId) && grant.policyDecisionId !== null));
      if (
        !grant ||
        !reference ||
        !effectAuthority ||
        grant.ownerScope !== 'workspace' ||
        grant.workspaceId !== input.workspaceId ||
        grant.vaultReferenceId !== entry.referenceId ||
        grant.status !== 'active' ||
        !grant.allowedInjectionPaths.includes('runtime-token') ||
        (grant.expiresAt !== null &&
          grant.expiresAt <= (input.now ?? (() => new Date().toISOString()))()) ||
        reference.ownerScope !== 'user' ||
        reference.userId !== entry.userId ||
        reference.userId === null ||
        !isCanonicalUserActive(coreDb, reference.userId) ||
        reference.status !== 'active' ||
        reference.login?.provider !== 'codex' ||
        reference.login.quarantined ||
        reference.currentVersion !== entry.currentVersion ||
        !currentWorkspaceAuthority(
          coreDb,
          input.workspaceId,
          input.actor,
          'vault.use',
          true,
          undefined,
          { dependencyFailure: 'throw' }
        )
      )
        refuse();
      if (requestedVersion !== undefined && requestedVersion !== entry.currentVersion)
        throw new VaultBackendError('version-expired', 'Vault material generation changed.');

      // Restricted Worker grants require their actual immutable consumer, not caller
      // hints. The existing AEP owner repeats target and current lineage predicates.
      if (
        input.planId !== undefined ||
        grant.targetAgentId !== null ||
        grant.targetAgentSessionId !== null ||
        grant.targetCapabilityId !== null ||
        grant.lifetime !== 'workspace'
      ) {
        const plan = input.planId ? getVaultInjectionPlan(coreDb, input.planId) : null;
        if (
          !plan ||
          plan.status !== 'active' ||
          plan.grantId !== grant.grantId ||
          plan.injectionVisibility !== 'runtime-token' ||
          !plan.packageSnapshotId
        )
          refuse();
        const snapshot = AgentEnvironmentPackageSchema.parse(
          requireAgentEnvironmentPackageSnapshot(
            input.db,
            input.workspaceId,
            plan.packageSnapshotId
          ).snapshot
        );
        if (
          snapshot.scope.agentSessionId !== input.agentSessionId ||
          snapshot.scope.workspaceId !== input.workspaceId ||
          !isDeepStrictEqual(snapshot.scope.triggerActor, input.actor)
        )
          refuse();
        const declaration = snapshot.credentials.declarations.find(
          (value) => value.vaultGrantId === grant.grantId
        );
        if (!declaration) refuse();
        assertCurrentWorkerCredentialAuthority(
          coreDb,
          snapshot,
          input.now ?? (() => new Date().toISOString()),
          declaration
        );
      }
    } finally {
      reader.close();
    }
  }

  /**
   * Records one non-secret use row.
   *
   * @param resolveInput Reference and optional version resolved.
   * @param outcome Resolve outcome.
   * @param failureCode Failure code for failed attempts.
   * @param materialVersion Exact resolved version, explicit failed version, or null.
   */
  private async recordUse(
    resolveInput: VaultResolveInput,
    outcome: 'succeeded' | 'failed',
    failureCode: string | null,
    materialVersion: number | null
  ): Promise<void> {
    const auditEventId = this.auditEventId();

    await createVaultUseRecord(this.input.db, {
      agentSessionId: this.input.agentSessionId ?? null,
      auditEventId,
      backendKind: this.kind,
      capabilityCallId: this.input.capabilityCallId ?? null,
      failureCode,
      grantId: this.input.grantId ?? null,
      materialVersion,
      outcome,
      ownerScope: this.input.ownerScope,
      planId: this.input.planId ?? null,
      receiptId: this.input.receiptId ?? null,
      resolvingPath: this.input.resolvingPath,
      usedAt: (this.input.now ?? (() => new Date().toISOString()))(),
      useId: (this.input.createUseId ?? (() => allocateEntityId('vu')))(),
      vaultReferenceId: resolveInput.referenceId,
      workspaceId: this.input.workspaceId ?? null,
    });

    if (!this.input.auditEventId && auditEventId) {
      const event = {
        action: 'vault.resolve',
        ...(this.input.actor ? { actor: this.input.actor } : {}),
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
        await recordVaultAuditEvent({
          ...event,
          workspaceDb: this.input.db,
          workspaceId: this.input.workspaceId ?? this.input.db.workspaceId,
        });
      } else {
        await recordVaultAuditEvent({
          ...event,
          coreDb: this.input.db,
          workspaceId: this.input.consumerWorkspaceId ?? null,
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

    return allocateEntityId('aud');
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
