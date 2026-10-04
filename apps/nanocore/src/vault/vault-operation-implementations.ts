import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type {
  OperationOutput,
  VAULT_OPERATION_DEFINITIONS,
  VaultAdminWorkspaceReference,
  WorkspaceVaultGrant,
} from '@openkit/app-api-schemas';

import { ProviderApiKeyProfileIdSchema } from '@openkit/app-api-schemas';
import { z } from 'zod';
import { isDeploymentAdminActor } from '../auth/identity.js';
import { loadProviderProfiles } from '../config/providers-loader.js';
import { StoreRecordNotFoundError } from '../lib/store.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { readVaultReferenceId } from '../providers/vault-credential-resolver.js';
import { listExportableVaultInjectionPlans } from '../vault-injection-plans.js';
import { listExportableVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { recordVaultAdminAuditEvent } from './vault-admin-audit-events.js';
import {
  createVaultGrant,
  getVaultGrant,
  listExportableWorkspaceVaultGrants,
  revokeVaultGrant,
} from './vault-grants.js';
import {
  advanceActiveVaultReferenceVersion,
  createVaultReference,
  createVaultReferenceWithInsertEvidence,
  getVaultReference,
  listWorkspaceVaultReferences,
  rebindWorkspaceVaultReference,
  revokeVaultReference,
} from './vault-references.js';
import type { VaultUnlockState } from './vault-unlock-state.js';
import {
  listExportableWorkspaceVaultUseRecords,
  listVaultUseRecords,
} from './vault-use-records.js';

const VAULT_UNLOCK_FAILURE_LIMIT = 5;
const VAULT_UNLOCK_FAILURE_WINDOW_MS = 60_000;
const CODEX_AUTH_JSON_VAULT_GRANT_ID = 'grant_codex_auth_json';
const CODEX_AUTH_JSON_VAULT_REFERENCE_ID = 'vault_codex_auth_json';
const CODEX_AUTH_JSON_TARGET_PATH = '/sandbox/.codex/auth.json';
const SAFE_PROVIDER_API_KEY_REFERENCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Shared invocation constructs families per request; retain the existing process-local counters and write fence with the app's unique unlock-state owner across HTTP and MCP entries. */
const administrationStates = new WeakMap<
  VaultUnlockState,
  { vaultUnlockFailuresByActor: Map<string, number[]>; providerApiKeyWrites: Set<string> }
>();

/** Joins Vault administration and redacted governance to their existing native owners. */
export function createVaultOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'dataRoot' | 'repositoryWorkspaceDb' | 'store' | 'vaultUnlockState'
  >
) {
  const { coreDb, dataRoot, repositoryWorkspaceDb, vaultUnlockState } = dependencies;
  let administrationState = vaultUnlockState
    ? administrationStates.get(vaultUnlockState)
    : undefined;
  if (!administrationState) {
    administrationState = {
      vaultUnlockFailuresByActor: new Map<string, number[]>(),
      providerApiKeyWrites: new Set<string>(),
    };
    if (vaultUnlockState) administrationStates.set(vaultUnlockState, administrationState);
  }
  const { vaultUnlockFailuresByActor, providerApiKeyWrites } = administrationState;

  /**
   * Returns the redacted vault admin status payload.
   *
   * @returns App API vault status payload.
   */
  function vaultAdminStatus() {
    if (!vaultUnlockState) {
      return {
        backendKind: 'encrypted-file' as const,
        diagnostic: 'Vault backend is not configured.',
        state: 'unavailable' as const,
      };
    }

    const health = vaultUnlockState.backend().health();

    return {
      backendKind: health.kind,
      diagnostic: health.diagnostic,
      state: health.state,
    };
  }

  /**
   * Returns an unavailable vault admin API error when no unlock state exists.
   *
   * @throws OperationError with the fixed unavailable refusal.
   */
  function vaultAdminUnavailableError(): never {
    return vaultFailure('Vault backend is not configured.', 'vault_backend_unavailable', 503);
  }

  /**
   * Returns the actor-scoped key used for vault unlock rate limiting.
   *
   * @param c Trusted admitted operation context.
   * @returns Stable actor key for this process.
   */
  function vaultUnlockActorKey(c: AdmittedOperationContext): string {
    const actor = publicOperationActor(c);

    return `${actor.kind}:${actor.userId}`;
  }

  /**
   * Returns active failed unlock attempts for the actor.
   *
   * @param c Trusted admitted operation context.
   * @returns Mutable active attempt timestamps.
   */
  function activeVaultUnlockFailures(c: AdmittedOperationContext): number[] {
    const key = vaultUnlockActorKey(c);
    const cutoff = Date.now() - VAULT_UNLOCK_FAILURE_WINDOW_MS;
    const active = (vaultUnlockFailuresByActor.get(key) ?? []).filter((at) => at >= cutoff);

    vaultUnlockFailuresByActor.set(key, active);

    return active;
  }

  /**
   * Checks whether the actor has exhausted failed unlock attempts.
   *
   * @param c Trusted admitted operation context.
   * @returns True when the next unlock request should be denied.
   */
  function isVaultUnlockRateLimited(c: AdmittedOperationContext): boolean {
    return activeVaultUnlockFailures(c).length >= VAULT_UNLOCK_FAILURE_LIMIT;
  }

  /**
   * Adds one failed unlock attempt to the actor's process-local window.
   *
   * @param c Trusted admitted operation context.
   */
  function rememberVaultUnlockFailure(c: AdmittedOperationContext): void {
    activeVaultUnlockFailures(c).push(Date.now());
  }

  /**
   * Clears failed unlock attempts after a successful unlock.
   *
   * @param c Trusted admitted operation context.
   */
  function clearVaultUnlockFailures(c: AdmittedOperationContext): void {
    vaultUnlockFailuresByActor.delete(vaultUnlockActorKey(c));
  }

  /**
   * Records a vault admin audit event when server storage is configured.
   *
   * @param c Trusted admitted operation context.
   * @param input Redacted audit fields.
   */
  function recordVaultAdminAudit(
    c: AdmittedOperationContext,
    input: {
      readonly action:
        | 'vault.unlock'
        | 'vault.lock'
        | 'vault.bootstrap_codex_auth_json'
        | 'vault.set_provider_api_key'
        | 'vault.rebind_workspace_reference';
      readonly outcome: 'succeeded' | 'failed' | 'denied';
      readonly summary: string;
      readonly errorCode?: string;
    }
  ): void {
    if (!coreDb) {
      return;
    }

    recordVaultAdminAuditEvent({
      action: input.action,
      actor: publicOperationActor(c),
      backendKind: vaultUnlockState?.backend().kind ?? 'encrypted-file',
      coreDb: coreDb,
      errorCode: input.errorCode ?? null,
      outcome: input.outcome,
      summary: input.summary,
    });
  }

  /** Returns one redacted provider API-key error after recording the failed mutation. */
  function providerApiKeyError(
    c: AdmittedOperationContext,
    message: string,
    errorCode: string,
    status: 400 | 404 | 409 | 423,
    outcome: 'failed' | 'denied' = 'failed'
  ): never {
    recordVaultAdminAudit(c, {
      action: 'vault.set_provider_api_key',
      errorCode,
      outcome,
      summary:
        outcome === 'denied'
          ? 'Provider API-key configuration denied.'
          : 'Provider API-key configuration failed.',
    });
    return vaultFailure(message, errorCode, status);
  }

  /** Executes the existing synchronous Vault lifecycle and its private failure compensation. */
  function mutate(
    input: {
      workspaceId: string;
      referenceId?: string;
      grantId?: string;
      material?: string;
      secretKind?: string;
      expiresAt?: string | undefined;
      injectionPath?: 'gateway-only' | 'runtime-env' | undefined;
    },
    c: AdmittedOperationContext,
    action: 'grant' | 'revoke-grant'
  ): WorkspaceVaultGrant;
  function mutate(
    input: {
      workspaceId: string;
      referenceId?: string;
      grantId?: string;
      material?: string;
      secretKind?: string;
      expiresAt?: string | undefined;
      injectionPath?: 'gateway-only' | 'runtime-env' | undefined;
    },
    c: AdmittedOperationContext,
    action: 'create' | 'rotate' | 'revoke'
  ): VaultAdminWorkspaceReference;
  function mutate(
    input: {
      workspaceId: string;
      referenceId?: string;
      grantId?: string;
      material?: string;
      secretKind?: string;
      expiresAt?: string | undefined;
      injectionPath?: 'gateway-only' | 'runtime-env' | undefined;
    },
    c: AdmittedOperationContext,
    action: 'create' | 'rotate' | 'revoke' | 'grant' | 'revoke-grant'
  ): VaultAdminWorkspaceReference | WorkspaceVaultGrant {
    if (!isDeploymentAdminActor(publicOperationActor(c)))
      return vaultFailure('Vault administration is forbidden.', 'deployment_admin_required', 403);
    if (!coreDb || !vaultUnlockState)
      return vaultFailure('Vault storage is unavailable.', 'vault_storage_unavailable', 503);
    const workspaceId = input.workspaceId;

    const backend = vaultUnlockState.backend();
    /** Record only fixed action and outcome text, never request or exception content. */
    const audit = (outcome: 'succeeded' | 'failed') =>
      recordVaultAdminAuditEvent({
        coreDb,
        actor: publicOperationActor(c),
        action: `vault.workspace_${action}`,
        backendKind: backend.kind,
        outcome,
        summary:
          outcome === 'succeeded'
            ? 'Workspace Vault mutation succeeded.'
            : 'Workspace Vault mutation failed.',
      });
    // This pre-existing private boundary compensates partial backend effects and publishes fixed text rather than backend material.
    let storedReferenceId: string | null = null;
    try {
      if (action === 'revoke-grant') {
        const grant = getVaultGrant(coreDb, input.grantId!);
        if (!grant || grant.ownerScope !== 'workspace' || grant.workspaceId !== workspaceId)
          return vaultFailure('Vault grant not found.', 'vault_grant_not_found', 404);
        const result = coreDb.sqlite.transaction(() =>
          revokeVaultGrant(coreDb, { grantId: grant.grantId })
        )();
        audit('succeeded');
        return result as WorkspaceVaultGrant;
      }
      if (backend.health().state !== 'available')
        return vaultFailure('Vault backend is not available.', 'vault_backend_not_available', 423);
      if (action === 'create') {
        const referenceId = `vault_${randomUUID()}`;
        const inventory = backend.store({
          referenceId,
          material: input.material!,
          metadata: { ownerScope: 'workspace', workspaceId },
        });
        storedReferenceId = referenceId;
        if (inventory.currentVersion !== 1 || inventory.revoked)
          throw new Error('Invalid initial version.');
        const created = createVaultReferenceWithInsertEvidence(coreDb, {
          referenceId,
          ownerScope: 'workspace',
          workspaceId,
          secretKind: input.secretKind!,
          displayName: input.secretKind!,
          backendKind: backend.kind,
          backendLocator: `${backend.kind}://workspace/${workspaceId}/vault/${referenceId}`,
        });
        if (!created.inserted) throw new Error('Reference conflict.');
        storedReferenceId = null;
        audit('succeeded');
        return projectReference(created.reference);
      }
      const referenceId = input.referenceId!;
      const reference = getVaultReference(coreDb, referenceId);
      if (
        !reference ||
        reference.ownerScope !== 'workspace' ||
        reference.workspaceId !== workspaceId
      )
        return vaultFailure('Vault reference not found.', 'vault_reference_not_found', 404);
      if (reference.status !== 'active')
        return vaultFailure('Vault reference is not active.', 'vault_reference_not_active', 409);
      const inventory = backend
        .listReferences({ ownerScope: 'workspace', workspaceId })
        .find((entry) => entry.referenceId === referenceId);
      if (
        !inventory ||
        inventory.revoked ||
        inventory.currentVersion !== reference.currentVersion ||
        inventory.backendKind !== reference.backendKind ||
        reference.backendKind !== backend.kind ||
        inventory.workspaceId !== workspaceId ||
        inventory.userId !== undefined ||
        inventory.providerSubscriptionAccount !== undefined ||
        reference.userId !== null ||
        reference.backendLocator !==
          `${backend.kind}://workspace/${workspaceId}/vault/${referenceId}`
      ) {
        return vaultFailure('Vault storage requires inspection.', 'vault_recovery_required', 409);
      }
      if (action === 'grant') {
        if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
          return vaultFailure('Grant expiry must be in the future.', 'invalid_request', 400);
        if (input.injectionPath === 'runtime-env' && reference.secretKind !== 'github-token')
          return vaultFailure(
            'Worker GitHub grant requires a GitHub token.',
            'invalid_request',
            400
          );
        const workerVisible = input.injectionPath === 'runtime-env';
        const grant = createVaultGrant(coreDb, {
          grantId: `grant_${randomUUID()}`,
          vaultReferenceId: referenceId,
          ownerScope: 'workspace',
          workspaceId,
          allowedInjectionPaths: [input.injectionPath ?? 'gateway-only'],
          targetCapabilityId: null,
          lifetime: 'workspace',
          subjectSummary: workerVisible ? 'Worker GitHub CLI' : 'Gateway-only credential',
          expiresAt: input.expiresAt ?? null,
        });
        audit('succeeded');
        return grant as WorkspaceVaultGrant;
      }
      if (action === 'rotate') {
        const rotated = backend.rotate({ referenceId, material: input.material! });
        const result = advanceActiveVaultReferenceVersion(coreDb, {
          referenceId,
          currentVersion: rotated.currentVersion,
        });
        audit('succeeded');
        return projectReference(result);
      }
      backend.revoke({ referenceId });
      const result = revokeVaultReference(coreDb, { referenceId });
      audit('succeeded');
      return projectReference(result);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (storedReferenceId) {
        try {
          backend.revoke({ referenceId: storedReferenceId });
        } catch {
          /* Failed cleanup requires inspection. */
        }
      }
      audit('failed');
      return vaultFailure(
        'Vault mutation failed; inspect inventory before a new request.',
        'vault_mutation_failed',
        409
      );
    }
  }

  return {
    'vault.status': () => {
      return vaultAdminStatus();
    },
    'vault.provider-api-key-set': async (input, c) => {
      if (!vaultUnlockState || !coreDb || !dataRoot) {
        return vaultFailure('Vault storage is not configured.', 'vault_storage_unavailable', 503);
      }

      const providerId = input.providerId;
      const safeProviderId = ProviderApiKeyProfileIdSchema.safeParse(providerId);

      if (!safeProviderId.success) {
        return providerApiKeyError(
          c,
          'Provider id is not supported for API-key configuration.',
          'provider_api_key_not_supported',
          400
        );
      }
      const response = { configured: true as const, providerId };
      let loaded: ReturnType<typeof loadProviderProfiles>;

      try {
        loaded = loadProviderProfiles(dataRoot);
      } catch (error) {
        if (error instanceof OperationError) throw error;
        return providerApiKeyError(
          c,
          'Provider profile configuration is invalid.',
          'provider_configuration_invalid',
          409
        );
      }
      const matchingProfiles = loaded.profiles.filter((candidate) => candidate.id === providerId);
      const hasProfileDiagnostic = loaded.diagnostics.some(
        (diagnostic) => diagnostic.profileId === providerId
      );

      if (matchingProfiles.length === 0 && !hasProfileDiagnostic) {
        return providerApiKeyError(c, 'Provider profile not found.', 'provider_not_found', 404);
      }
      if (matchingProfiles.length !== 1 || hasProfileDiagnostic) {
        return providerApiKeyError(
          c,
          'Provider profile configuration is invalid.',
          'provider_configuration_invalid',
          409
        );
      }

      const profile = matchingProfiles[0]!;
      const referenceId = profile.secretRef ? readVaultReferenceId(profile.secretRef) : null;

      if (!referenceId || !SAFE_PROVIDER_API_KEY_REFERENCE_ID.test(referenceId)) {
        return providerApiKeyError(
          c,
          'Provider profile does not use a supported Vault API-key reference.',
          'provider_api_key_not_supported',
          400
        );
      }
      if (providerApiKeyWrites.has(referenceId)) {
        return providerApiKeyError(
          c,
          'Provider API-key update is already in progress.',
          'provider_api_key_update_active',
          409,
          'denied'
        );
      }

      providerApiKeyWrites.add(referenceId);
      let storedNewMaterial = false;

      try {
        const backend = vaultUnlockState.backend();

        if (backend.health().state !== 'available') {
          return providerApiKeyError(
            c,
            'Vault backend is not available.',
            'vault_backend_not_available',
            423
          );
        }

        let reference = getVaultReference(coreDb, referenceId);
        const inventory = backend
          .listReferences({ ownerScope: 'server' })
          .find((candidate) => candidate.referenceId === referenceId);

        if (Boolean(reference) !== Boolean(inventory)) {
          return providerApiKeyError(
            c,
            'Provider API-key storage requires recovery.',
            'provider_api_key_recovery_required',
            409
          );
        }

        if (!reference && !inventory) {
          const stored = backend.store({
            material: input.apiKey,
            metadata: { ownerScope: 'server' },
            referenceId,
          });
          storedNewMaterial = true;

          if (stored.currentVersion !== 1 || stored.revoked) {
            throw new Error('Provider API-key Vault store returned an invalid initial version.');
          }

          const created = createVaultReferenceWithInsertEvidence(coreDb, {
            backendKind: backend.kind,
            backendLocator: `${backend.kind}://server/vault/${referenceId}`,
            displayName: 'Provider API key',
            ownerScope: 'server',
            referenceId,
            secretKind: 'provider-api-key',
          });

          if (!created.inserted) {
            throw new Error('Provider API-key Vault reference already exists.');
          }
          reference = created.reference;
          storedNewMaterial = false;
        } else if (reference && inventory) {
          const exactReference =
            reference.ownerScope === 'server' &&
            reference.workspaceId === null &&
            reference.userId === null &&
            reference.displayName === 'Provider API key' &&
            reference.secretKind === 'provider-api-key' &&
            reference.backendKind === backend.kind &&
            reference.backendLocator === `${backend.kind}://server/vault/${referenceId}` &&
            reference.status === 'active';
          const exactInventory =
            inventory.ownerScope === 'server' &&
            inventory.backendKind === backend.kind &&
            !inventory.revoked &&
            inventory.workspaceId === undefined &&
            inventory.userId === undefined &&
            inventory.providerSubscriptionAccount === undefined;

          if (!exactReference || !exactInventory) {
            return providerApiKeyError(
              c,
              'Provider API-key storage requires recovery.',
              'provider_api_key_recovery_required',
              409
            );
          }
          if (inventory.currentVersion === reference.currentVersion + 1) {
            reference = advanceActiveVaultReferenceVersion(coreDb, {
              currentVersion: inventory.currentVersion,
              referenceId,
            });
          } else if (inventory.currentVersion !== reference.currentVersion) {
            return providerApiKeyError(
              c,
              'Provider API-key storage requires recovery.',
              'provider_api_key_recovery_required',
              409
            );
          }

          const rotated = backend.rotate({ material: input.apiKey, referenceId });
          reference = advanceActiveVaultReferenceVersion(coreDb, {
            currentVersion: rotated.currentVersion,
            referenceId,
          });
        }

        if (!reference) {
          throw new Error('Provider API-key Vault reference was not stored.');
        }

        recordVaultAdminAudit(c, {
          action: 'vault.set_provider_api_key',
          outcome: 'succeeded',
          summary: 'Provider API-key configuration succeeded.',
        });

        return response;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        let recoveryRequired = false;

        if (storedNewMaterial) {
          recoveryRequired = true;
          try {
            vaultUnlockState.backend().revoke({ referenceId });
          } catch (error) {
            if (error instanceof OperationError) throw error;
            // The failed write remains recovery-required whether cleanup settles or not.
          }
        }

        recordVaultAdminAudit(c, {
          action: 'vault.set_provider_api_key',
          errorCode: recoveryRequired
            ? 'provider_api_key_recovery_required'
            : 'provider_api_key_persistence_failed',
          outcome: 'failed',
          summary: 'Provider API-key configuration failed.',
        });

        return recoveryRequired
          ? vaultFailure(
              'Provider API-key storage requires recovery.',
              'provider_api_key_recovery_required',
              409
            )
          : vaultFailure(
              'Provider API-key configuration failed.',
              'provider_api_key_persistence_failed',
              500
            );
      } finally {
        providerApiKeyWrites.delete(referenceId);
      }
    },
    'vault.server-use-list': () => {
      try {
        if (!coreDb) {
          return vaultFailure('Core DB is not available.', 'not_found', 404);
        }

        return {
          vaultUseRecords: listVaultUseRecords(coreDb),
        } as OperationOutput<'vault.server-use-list'>;
      } catch (error) {
        vaultReadFailure(error);
      }
    },
    'vault.unlock': async (input, c) => {
      const unlockState = vaultUnlockState;

      if (!unlockState) {
        return vaultAdminUnavailableError();
      }

      if (isVaultUnlockRateLimited(c)) {
        recordVaultAdminAudit(c, {
          action: 'vault.unlock',
          errorCode: 'vault_unlock_rate_limited',
          outcome: 'denied',
          summary: 'Vault unlock denied because recent failed attempts exceeded the limit.',
        });

        return vaultFailure('Vault unlock rate limit exceeded.', 'vault_unlock_rate_limited', 429);
      }

      const masterKey = Buffer.from(input.masterKeyBase64, 'base64');

      try {
        unlockState.unlock({
          masterKey,
        });
        clearVaultUnlockFailures(c);
        recordVaultAdminAudit(c, {
          action: 'vault.unlock',
          outcome: 'succeeded',
          summary: 'Vault unlock succeeded.',
        });

        return vaultAdminStatus();
      } catch (error) {
        if (error instanceof OperationError) throw error;
        rememberVaultUnlockFailure(c);
        recordVaultAdminAudit(c, {
          action: 'vault.unlock',
          errorCode: 'vault_unlock_failed',
          outcome: 'failed',
          summary: 'Vault unlock failed.',
        });

        return vaultFailure('Vault unlock failed.', 'vault_unlock_failed', 400);
      } finally {
        masterKey.fill(0);
      }
    },
    'vault.bootstrap-codex-auth': async (input, c) => {
      const unlockState = vaultUnlockState;

      if (!unlockState) {
        return vaultAdminUnavailableError();
      }
      if (!coreDb) {
        return vaultFailure('Vault storage is not configured.', 'vault_storage_unavailable', 503);
      }

      const backend = unlockState.backend();
      const health = backend.health();

      if (health.state !== 'available') {
        recordVaultAdminAudit(c, {
          action: 'vault.bootstrap_codex_auth_json',
          errorCode: 'vault_backend_not_available',
          outcome: 'failed',
          summary: 'Codex auth JSON bootstrap failed because the vault backend is not available.',
        });

        return vaultFailure('Vault backend is not available.', 'vault_backend_not_available', 423);
      }
      if (getVaultReference(coreDb, CODEX_AUTH_JSON_VAULT_REFERENCE_ID)) {
        recordVaultAdminAudit(c, {
          action: 'vault.bootstrap_codex_auth_json',
          errorCode: 'vault_codex_auth_json_exists',
          outcome: 'failed',
          summary: 'Codex auth JSON bootstrap failed because the vault reference already exists.',
        });

        return vaultFailure(
          'Codex auth JSON vault reference already exists.',
          'vault_codex_auth_json_exists',
          409
        );
      }

      try {
        const authJson = Buffer.from(input.authJsonBase64, 'base64').toString('utf8');
        const decoded = JSON.parse(authJson) as unknown;

        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('Codex auth JSON must decode to a JSON object.');
        }

        backend.store({
          material: authJson,
          metadata: { ownerScope: 'server' },
          referenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
        });
        createVaultReference(coreDb, {
          backendKind: backend.kind,
          backendLocator: `${backend.kind}://server/vault/${CODEX_AUTH_JSON_VAULT_REFERENCE_ID}`,
          displayName: 'Codex auth JSON',
          ownerScope: 'server',
          referenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
          secretKind: 'codex-auth-json',
        });
        createVaultGrant(coreDb, {
          allowedInjectionPaths: ['runtime-file'],
          expiresAt: input.expiresAt ?? null,
          grantId: CODEX_AUTH_JSON_VAULT_GRANT_ID,
          lifetime: 'agent-session',
          ownerScope: 'server',
          subjectSummary: 'Codex auth JSON runtime-file injection',
          vaultReferenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
        });
        recordVaultAdminAudit(c, {
          action: 'vault.bootstrap_codex_auth_json',
          outcome: 'succeeded',
          summary: 'Codex auth JSON bootstrap succeeded.',
        });

        return {
          backendKind: backend.kind,
          expiresAt: input.expiresAt ?? null,
          grantId: CODEX_AUTH_JSON_VAULT_GRANT_ID,
          grantScope: 'agent-session',
          referenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
          secretKind: 'codex-auth-json',
          targetPath: CODEX_AUTH_JSON_TARGET_PATH,
        } as OperationOutput<'vault.bootstrap-codex-auth'>;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        recordVaultAdminAudit(c, {
          action: 'vault.bootstrap_codex_auth_json',
          errorCode: 'vault_codex_auth_json_bootstrap_failed',
          outcome: 'failed',
          summary: 'Codex auth JSON bootstrap failed.',
        });

        return vaultFailure(
          'Codex auth JSON bootstrap failed.',
          'vault_codex_auth_json_bootstrap_failed',
          400
        );
      }
    },
    'vault.reference-rebind': async (input, c) => {
      const unlockState = vaultUnlockState;

      if (!unlockState) {
        return vaultAdminUnavailableError();
      }
      if (!coreDb) {
        return vaultFailure('Vault storage is not configured.', 'vault_storage_unavailable', 503);
      }

      const workspaceId = input.workspaceId;
      const referenceId = input.referenceId;

      const reference = getVaultReference(coreDb, referenceId);

      if (!reference) {
        return vaultFailure(
          'Workspace vault reference not found.',
          'vault_reference_not_found',
          404
        );
      }
      if (reference.workspaceId !== workspaceId)
        throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
      if (reference.ownerScope !== 'workspace' || reference.workspaceId !== workspaceId) {
        return vaultFailure(
          'Workspace vault reference not found.',
          'vault_reference_not_found',
          404
        );
      }
      if (reference.status !== 'unbound') {
        return vaultFailure(
          'Workspace vault reference is not unbound.',
          'vault_reference_not_unbound',
          409
        );
      }

      const backend = unlockState.backend();
      const health = backend.health();

      if (health.state !== 'available') {
        recordVaultAdminAudit(c, {
          action: 'vault.rebind_workspace_reference',
          errorCode: 'vault_backend_not_available',
          outcome: 'failed',
          summary:
            'Workspace vault reference rebind failed because the vault backend is not available.',
        });

        return vaultFailure('Vault backend is not available.', 'vault_backend_not_available', 423);
      }

      try {
        const inventory = backend.store({
          material: Buffer.from(input.materialBase64, 'base64'),
          metadata: { ownerScope: 'workspace', workspaceId },
          referenceId,
        });
        const rebound = rebindWorkspaceVaultReference(coreDb, {
          backendKind: backend.kind,
          backendLocator: `${backend.kind}://workspace/${workspaceId}/vault/${referenceId}`,
          currentVersion: inventory.currentVersion,
          referenceId,
          workspaceId,
        });

        recordVaultAdminAudit(c, {
          action: 'vault.rebind_workspace_reference',
          outcome: 'succeeded',
          summary: 'Workspace vault reference rebind succeeded.',
        });

        return {
          backendKind: rebound.backendKind,
          currentVersion: rebound.currentVersion,
          ownerScope: rebound.ownerScope,
          referenceId: rebound.referenceId,
          secretKind: rebound.secretKind,
          status: rebound.status,
          workspaceId: rebound.workspaceId,
        } as OperationOutput<'vault.reference-rebind'>;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        recordVaultAdminAudit(c, {
          action: 'vault.rebind_workspace_reference',
          errorCode: 'vault_reference_rebind_failed',
          outcome: 'failed',
          summary: 'Workspace vault reference rebind failed.',
        });

        return vaultFailure(
          'Workspace vault reference rebind failed.',
          'vault_reference_rebind_failed',
          400
        );
      }
    },
    'vault.reference-list': (input) => {
      if (!coreDb) {
        return vaultFailure('Vault storage is not configured.', 'vault_storage_unavailable', 503);
      }

      const workspaceId = input.workspaceId;
      const items = listWorkspaceVaultReferences(coreDb, workspaceId).map((reference) => ({
        backendKind: reference.backendKind,
        currentVersion: reference.currentVersion,
        ownerScope: reference.ownerScope,
        referenceId: reference.referenceId,
        secretKind: reference.secretKind,
        status: reference.status,
        workspaceId: reference.workspaceId,
      }));

      return {
        items,
        workspaceId,
      } as OperationOutput<'vault.reference-list'>;
    },
    'vault.use-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);

        try {
          return {
            workspaceId,
            vaultUseRecords: listExportableWorkspaceVaultUseRecords(workspaceDb, workspaceId),
          } as OperationOutput<'vault.use-list'>;
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        vaultReadFailure(error);
      }
    },
    'vault.lock': (_input, c) => {
      const unlockState = vaultUnlockState;

      if (!unlockState) {
        return vaultAdminUnavailableError();
      }

      unlockState.lock();
      recordVaultAdminAudit(c, {
        action: 'vault.lock',
        outcome: 'succeeded',
        summary: 'Vault lock succeeded.',
      });

      return vaultAdminStatus();
    },
    'vault.grant-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        dependencies.store!.getWorkspace(workspaceId);

        if (!coreDb) {
          return vaultFailure('Core DB is not available.', 'not_found', 404);
        }

        return {
          workspaceId,
          items: listExportableWorkspaceVaultGrants(coreDb, workspaceId),
        } as OperationOutput<'vault.grant-list'>;
      } catch (error) {
        vaultReadFailure(error);
      }
    },
    'vault.injection-plan-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        dependencies.store!.getWorkspace(workspaceId);

        if (!coreDb) {
          return vaultFailure('Core DB is not available.', 'not_found', 404);
        }

        const grantIds = listExportableWorkspaceVaultGrants(coreDb, workspaceId).map(
          (grant) => grant.grantId
        );
        return {
          workspaceId,
          items: listExportableVaultInjectionPlans(coreDb, grantIds),
        } as OperationOutput<'vault.injection-plan-list'>;
      } catch (error) {
        vaultReadFailure(error);
      }
    },
    'vault.injection-receipt-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        dependencies.store!.getWorkspace(workspaceId);

        if (!coreDb) {
          return vaultFailure('Core DB is not available.', 'not_found', 404);
        }

        const grantIds = listExportableWorkspaceVaultGrants(coreDb, workspaceId).map(
          (grant) => grant.grantId
        );
        const planIds = listExportableVaultInjectionPlans(coreDb, grantIds).map(
          (plan) => plan.planId
        );
        return {
          workspaceId,
          items: listExportableVaultInjectionReceipts(coreDb, planIds),
        } as OperationOutput<'vault.injection-receipt-list'>;
      } catch (error) {
        vaultReadFailure(error);
      }
    },
    'vault.secret-create': (input, c) => mutate(input, c, 'create'),
    'vault.secret-rotate': (input, c) => mutate(input, c, 'rotate'),
    'vault.secret-revoke': (input, c) => mutate(input, c, 'revoke'),
    'vault.grant-create': (input, c) => mutate(input, c, 'grant'),
    'vault.grant-revoke': (input, c) => mutate(input, c, 'revoke-grant'),
  } satisfies FamilyImplementations<typeof VAULT_OPERATION_DEFINITIONS>;
}
/** Select public metadata explicitly, excluding backend locators and display content; native Workspace creation and ownership checks establish the narrower type, and shared framing validates it. */
function projectReference(reference: NonNullable<ReturnType<typeof getVaultReference>>) {
  const { backendKind, currentVersion, ownerScope, referenceId, secretKind, status, workspaceId } =
    reference;
  return {
    backendKind,
    currentVersion,
    ownerScope,
    referenceId,
    secretKind,
    status,
    workspaceId,
  } as VaultAdminWorkspaceReference;
}

/** Publishes only fixed Vault refusal fields; backend causes stay inside their existing safe boundary. */
function vaultFailure(message: string, code: string, status: number): never {
  throw new OperationError(code, message, status);
}
/** Classifies only retained decoder and unavailable-record failures; unexpected read failures escape. */
function vaultReadFailure(error: unknown): never {
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    throw new OperationError('not_found', 'The retained record could not be read.', 404, {
      cause: error,
    });
  if (error instanceof StoreRecordNotFoundError)
    throw new OperationError('not_found', error.message, 404, { cause: error });
  throw error;
}
