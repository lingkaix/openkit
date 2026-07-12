import { Buffer } from 'node:buffer';

import {
  ListServerVaultUseRecordsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  VaultAdminBootstrapCodexAuthJsonRequestSchema,
  VaultAdminBootstrapCodexAuthJsonResponseSchema,
  VaultAdminListWorkspaceReferencesResponseSchema,
  VaultAdminLockResponseSchema,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  VaultAdminRebindWorkspaceReferenceResponseSchema,
  VaultAdminStatusResponseSchema,
  VaultAdminUnlockRequestSchema,
  VaultAdminUnlockResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import { isDeploymentAdminActor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { recordVaultAdminAuditEvent } from './vault-admin-audit-events.js';
import { createVaultGrant } from './vault-grants.js';
import {
  createVaultReference,
  getVaultReference,
  listWorkspaceVaultReferences,
  rebindWorkspaceVaultReference,
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

/**
 * Registers the complete Vault administration App API feature path.
 *
 * @param dependencies Hono app and Vault administration dependencies.
 */
export function registerVaultAdminRoutes({
  app,
  coreDb,
  repositoryWorkspaceDb,
  requestStore,
  vaultUnlockState,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly vaultUnlockState: VaultUnlockState | null;
}): void {
  const vaultUnlockFailuresByActor = new Map<string, number[]>();

  /**
   * Returns the redacted vault admin status payload.
   *
   * @returns App API vault status payload.
   */
  function vaultAdminStatus() {
    if (!vaultUnlockState) {
      return VaultAdminStatusResponseSchema.parse({
        backendKind: 'encrypted-file',
        diagnostic: 'Vault backend is not configured.',
        state: 'unavailable',
      });
    }

    const health = vaultUnlockState.backend().health();

    return VaultAdminStatusResponseSchema.parse({
      backendKind: health.kind,
      diagnostic: health.diagnostic,
      state: health.state,
    });
  }

  /**
   * Returns an unavailable vault admin API error when no unlock state exists.
   *
   * @returns API error response.
   */
  function vaultAdminUnavailableError(): Response {
    return asApiError('Vault backend is not configured.', 'vault_backend_unavailable', 503);
  }

  /**
   * Returns the actor-scoped key used for vault unlock rate limiting.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Stable actor key for this process.
   */
  function vaultUnlockActorKey(c: Context<{ Variables: AuthVariables }>): string {
    const actor = c.get('actor');

    return actor ? `${actor.kind}:${actor.userId}` : 'unknown';
  }

  /**
   * Returns active failed unlock attempts for the actor.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Mutable active attempt timestamps.
   */
  function activeVaultUnlockFailures(c: Context<{ Variables: AuthVariables }>): number[] {
    const key = vaultUnlockActorKey(c);
    const cutoff = Date.now() - VAULT_UNLOCK_FAILURE_WINDOW_MS;
    const active = (vaultUnlockFailuresByActor.get(key) ?? []).filter((at) => at >= cutoff);

    vaultUnlockFailuresByActor.set(key, active);

    return active;
  }

  /**
   * Checks whether the actor has exhausted failed unlock attempts.
   *
   * @param c Hono context carrying the actor variable.
   * @returns True when the next unlock request should be denied.
   */
  function isVaultUnlockRateLimited(c: Context<{ Variables: AuthVariables }>): boolean {
    return activeVaultUnlockFailures(c).length >= VAULT_UNLOCK_FAILURE_LIMIT;
  }

  /**
   * Adds one failed unlock attempt to the actor's process-local window.
   *
   * @param c Hono context carrying the actor variable.
   */
  function rememberVaultUnlockFailure(c: Context<{ Variables: AuthVariables }>): void {
    activeVaultUnlockFailures(c).push(Date.now());
  }

  /**
   * Clears failed unlock attempts after a successful unlock.
   *
   * @param c Hono context carrying the actor variable.
   */
  function clearVaultUnlockFailures(c: Context<{ Variables: AuthVariables }>): void {
    vaultUnlockFailuresByActor.delete(vaultUnlockActorKey(c));
  }

  /**
   * Records a vault admin audit event when server storage is configured.
   *
   * @param c Hono context carrying the actor variable.
   * @param input Redacted audit fields.
   */
  function recordVaultAdminAudit(
    c: Context<{ Variables: AuthVariables }>,
    input: {
      readonly action:
        | 'vault.unlock'
        | 'vault.lock'
        | 'vault.bootstrap_codex_auth_json'
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
      actor: c.get('actor'),
      backendKind: vaultUnlockState?.backend().kind ?? 'encrypted-file',
      coreDb: coreDb,
      errorCode: input.errorCode ?? null,
      outcome: input.outcome,
      summary: input.summary,
    });
  }

  /**
   * Requires deployment-admin authority for a server-wide Vault operation.
   *
   * @param c Hono context carrying the authenticated actor.
   * @returns Error response when the actor lacks deployment-admin authority.
   */
  function requireVaultAdminActor(c: Context<{ Variables: AuthVariables }>): Response | null {
    if (isDeploymentAdminActor(c.get('actor'))) {
      return null;
    }

    return asApiError('Server-admin authority is required.', 'vault_admin_forbidden', 403);
  }

  registerAppApiRoute(app, 'getVaultAdminStatus', (c) => {
    const adminError = requireVaultAdminActor(c);

    return adminError ?? c.json(vaultAdminStatus());
  });

  registerAppApiRoute(app, 'listServerVaultUseRecords', (c) => {
    const adminError = requireVaultAdminActor(c);
    if (adminError) {
      return adminError;
    }

    try {
      if (!coreDb) {
        return asApiError('Core DB is not available.');
      }

      return c.json(
        ListServerVaultUseRecordsResponseSchema.parse({
          vaultUseRecords: listVaultUseRecords(coreDb),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'unlockVaultAdminBackend', async (c) => {
    const adminError = requireVaultAdminActor(c);
    if (adminError) {
      return adminError;
    }

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

      return asApiError('Vault unlock rate limit exceeded.', 'vault_unlock_rate_limited', 429);
    }

    const parsed = VaultAdminUnlockRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const masterKey = Buffer.from(parsed.data.masterKeyBase64, 'base64');

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

      return c.json(VaultAdminUnlockResponseSchema.parse(vaultAdminStatus()));
    } catch {
      rememberVaultUnlockFailure(c);
      recordVaultAdminAudit(c, {
        action: 'vault.unlock',
        errorCode: 'vault_unlock_failed',
        outcome: 'failed',
        summary: 'Vault unlock failed.',
      });

      return asApiError('Vault unlock failed.', 'vault_unlock_failed', 400);
    } finally {
      masterKey.fill(0);
    }
  });

  registerAppApiRoute(app, 'bootstrapCodexAuthJsonVaultReference', async (c) => {
    const adminError = requireVaultAdminActor(c);
    if (adminError) {
      return adminError;
    }

    const unlockState = vaultUnlockState;

    if (!unlockState) {
      return vaultAdminUnavailableError();
    }
    if (!coreDb) {
      return asApiError('Vault storage is not configured.', 'vault_storage_unavailable', 503);
    }

    const parsed = VaultAdminBootstrapCodexAuthJsonRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
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

      return asApiError('Vault backend is not available.', 'vault_backend_not_available', 423);
    }
    if (getVaultReference(coreDb, CODEX_AUTH_JSON_VAULT_REFERENCE_ID)) {
      recordVaultAdminAudit(c, {
        action: 'vault.bootstrap_codex_auth_json',
        errorCode: 'vault_codex_auth_json_exists',
        outcome: 'failed',
        summary: 'Codex auth JSON bootstrap failed because the vault reference already exists.',
      });

      return asApiError(
        'Codex auth JSON vault reference already exists.',
        'vault_codex_auth_json_exists',
        409
      );
    }

    try {
      const authJson = Buffer.from(parsed.data.authJsonBase64, 'base64').toString('utf8');
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
        expiresAt: parsed.data.expiresAt ?? null,
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

      return c.json(
        VaultAdminBootstrapCodexAuthJsonResponseSchema.parse({
          backendKind: backend.kind,
          expiresAt: parsed.data.expiresAt ?? null,
          grantId: CODEX_AUTH_JSON_VAULT_GRANT_ID,
          grantScope: 'agent-session',
          referenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
          secretKind: 'codex-auth-json',
          targetPath: CODEX_AUTH_JSON_TARGET_PATH,
        })
      );
    } catch {
      recordVaultAdminAudit(c, {
        action: 'vault.bootstrap_codex_auth_json',
        errorCode: 'vault_codex_auth_json_bootstrap_failed',
        outcome: 'failed',
        summary: 'Codex auth JSON bootstrap failed.',
      });

      return asApiError(
        'Codex auth JSON bootstrap failed.',
        'vault_codex_auth_json_bootstrap_failed',
        400
      );
    }
  });

  registerAppApiRoute(app, 'rebindWorkspaceVaultReference', async (c) => {
    const unlockState = vaultUnlockState;

    if (!unlockState) {
      return vaultAdminUnavailableError();
    }
    if (!coreDb) {
      return asApiError('Vault storage is not configured.', 'vault_storage_unavailable', 503);
    }

    const workspaceId = c.req.param('workspaceId');
    const referenceId = c.req.param('referenceId');
    const parsed = VaultAdminRebindWorkspaceReferenceRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const reference = getVaultReference(coreDb, referenceId);

    if (
      !reference ||
      reference.ownerScope !== 'workspace' ||
      reference.workspaceId !== workspaceId
    ) {
      return asApiError('Workspace vault reference not found.', 'vault_reference_not_found', 404);
    }
    if (reference.status !== 'unbound') {
      return asApiError(
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

      return asApiError('Vault backend is not available.', 'vault_backend_not_available', 423);
    }

    try {
      const inventory = backend.store({
        material: Buffer.from(parsed.data.materialBase64, 'base64'),
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

      return c.json(
        VaultAdminRebindWorkspaceReferenceResponseSchema.parse({
          backendKind: rebound.backendKind,
          currentVersion: rebound.currentVersion,
          ownerScope: rebound.ownerScope,
          referenceId: rebound.referenceId,
          secretKind: rebound.secretKind,
          status: rebound.status,
          workspaceId: rebound.workspaceId,
        })
      );
    } catch {
      recordVaultAdminAudit(c, {
        action: 'vault.rebind_workspace_reference',
        errorCode: 'vault_reference_rebind_failed',
        outcome: 'failed',
        summary: 'Workspace vault reference rebind failed.',
      });

      return asApiError(
        'Workspace vault reference rebind failed.',
        'vault_reference_rebind_failed',
        400
      );
    }
  });

  registerAppApiRoute(app, 'listWorkspaceVaultReferences', (c) => {
    if (!coreDb) {
      return asApiError('Vault storage is not configured.', 'vault_storage_unavailable', 503);
    }

    const workspaceId = c.req.param('workspaceId');
    const items = listWorkspaceVaultReferences(coreDb, workspaceId).map((reference) => ({
      backendKind: reference.backendKind,
      currentVersion: reference.currentVersion,
      ownerScope: reference.ownerScope,
      referenceId: reference.referenceId,
      secretKind: reference.secretKind,
      status: reference.status,
      workspaceId: reference.workspaceId,
    }));

    return c.json(
      VaultAdminListWorkspaceReferencesResponseSchema.parse({
        items,
        workspaceId,
      })
    );
  });

  registerAppApiRoute(app, 'listWorkspaceVaultUseRecords', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          ListWorkspaceVaultUseRecordsResponseSchema.parse({
            workspaceId,
            vaultUseRecords: listExportableWorkspaceVaultUseRecords(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'lockVaultAdminBackend', (c) => {
    const adminError = requireVaultAdminActor(c);
    if (adminError) {
      return adminError;
    }

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

    return c.json(VaultAdminLockResponseSchema.parse(vaultAdminStatus()));
  });
}
