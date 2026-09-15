import { randomUUID } from 'node:crypto';
import {
  CreateWorkspaceVaultGrantRequestSchema,
  CreateWorkspaceVaultSecretRequestSchema,
  RotateWorkspaceVaultSecretRequestSchema,
  VaultAdminWorkspaceReferenceSchema,
  WorkspaceVaultGrantSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { asApiError } from '../api-errors.js';
import { isDeploymentAdminActor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerAppApiRoute } from '../openapi.js';
import type { CoreDb } from '../storage/db.js';
import { recordVaultAdminAuditEvent } from './vault-admin-audit-events.js';
import { createVaultGrant, getVaultGrant, revokeVaultGrant } from './vault-grants.js';
import {
  advanceActiveVaultReferenceVersion,
  createVaultReferenceWithInsertEvidence,
  getVaultReference,
  revokeVaultReference,
} from './vault-references.js';
import type { VaultUnlockState } from './vault-unlock-state.js';

/** Project existing workspace Vault lifecycle through deployment-admin operations. */
export function registerVaultSecretRoutes({
  app,
  coreDb,
  vaultUnlockState,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly vaultUnlockState: VaultUnlockState | null;
}): void {
  /** Execute one synchronous, scoped mutation after parsing input; never expose caught errors. */
  async function mutate(
    c: Context<{ Variables: AuthVariables }>,
    action: 'create' | 'rotate' | 'revoke' | 'grant' | 'revoke-grant'
  ): Promise<Response> {
    c.header('Cache-Control', 'no-store');
    if (!isDeploymentAdminActor(c.get('actor')))
      return asApiError('Vault administration is forbidden.', 'vault_admin_forbidden', 403);
    if (!coreDb || !vaultUnlockState)
      return asApiError('Vault storage is unavailable.', 'vault_storage_unavailable', 503);
    const workspaceId = c.req.param('workspaceId')!;
    const body: unknown = await c.req.json().catch(() => null);
    const backend = vaultUnlockState.backend();
    /** Record only fixed action and outcome text, never request or exception content. */
    const audit = (outcome: 'succeeded' | 'failed') =>
      recordVaultAdminAuditEvent({
        coreDb,
        actor: c.get('actor'),
        action: `vault.workspace_${action}`,
        backendKind: backend.kind,
        outcome,
        summary:
          outcome === 'succeeded'
            ? 'Workspace Vault mutation succeeded.'
            : 'Workspace Vault mutation failed.',
      });
    let storedReferenceId: string | null = null;
    try {
      if (action === 'revoke-grant') {
        const grant = getVaultGrant(coreDb, c.req.param('grantId')!);
        if (!grant || grant.ownerScope !== 'workspace' || grant.workspaceId !== workspaceId)
          return asApiError('Vault grant not found.', 'vault_grant_not_found', 404);
        const result = coreDb.sqlite.transaction(() =>
          revokeVaultGrant(coreDb, { grantId: grant.grantId })
        )();
        audit('succeeded');
        return c.json(WorkspaceVaultGrantSchema.parse(result));
      }
      if (backend.health().state !== 'available')
        return asApiError('Vault backend is not available.', 'vault_backend_not_available', 423);
      if (action === 'create') {
        const parsed = CreateWorkspaceVaultSecretRequestSchema.safeParse(body);
        if (!parsed.success)
          return asApiError('Invalid Vault secret input.', 'invalid_request', 400);
        const referenceId = `vault_${randomUUID()}`;
        const inventory = backend.store({
          referenceId,
          material: parsed.data.material,
          metadata: { ownerScope: 'workspace', workspaceId },
        });
        storedReferenceId = referenceId;
        if (inventory.currentVersion !== 1 || inventory.revoked)
          throw new Error('Invalid initial version.');
        const created = createVaultReferenceWithInsertEvidence(coreDb, {
          referenceId,
          ownerScope: 'workspace',
          workspaceId,
          secretKind: parsed.data.secretKind,
          displayName: parsed.data.secretKind,
          backendKind: backend.kind,
          backendLocator: `${backend.kind}://workspace/${workspaceId}/vault/${referenceId}`,
        });
        if (!created.inserted) throw new Error('Reference conflict.');
        storedReferenceId = null;
        audit('succeeded');
        return c.json(projectReference(created.reference));
      }
      const grantInput =
        action === 'grant' ? CreateWorkspaceVaultGrantRequestSchema.safeParse(body) : null;
      if (grantInput && !grantInput.success)
        return asApiError('Invalid Vault grant input.', 'invalid_request', 400);
      const referenceId = grantInput?.success
        ? grantInput.data.referenceId
        : c.req.param('referenceId')!;
      const reference = getVaultReference(coreDb, referenceId);
      if (
        !reference ||
        reference.ownerScope !== 'workspace' ||
        reference.workspaceId !== workspaceId
      )
        return asApiError('Vault reference not found.', 'vault_reference_not_found', 404);
      if (reference.status !== 'active')
        return asApiError('Vault reference is not active.', 'vault_reference_not_active', 409);
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
        return asApiError('Vault storage requires inspection.', 'vault_recovery_required', 409);
      }
      if (action === 'grant' && grantInput?.success) {
        if (grantInput.data.expiresAt && Date.parse(grantInput.data.expiresAt) <= Date.now())
          return asApiError('Grant expiry must be in the future.', 'invalid_request', 400);
        const grant = createVaultGrant(coreDb, {
          grantId: `grant_${randomUUID()}`,
          vaultReferenceId: referenceId,
          ownerScope: 'workspace',
          workspaceId,
          allowedInjectionPaths: ['gateway-only'],
          targetCapabilityId: 'workspace.git.push',
          lifetime: 'workspace',
          subjectSummary: 'Approved host Git push',
          expiresAt: grantInput.data.expiresAt ?? null,
        });
        audit('succeeded');
        return c.json(WorkspaceVaultGrantSchema.parse(grant));
      }
      if (action === 'rotate') {
        const parsed = RotateWorkspaceVaultSecretRequestSchema.safeParse(body);
        if (!parsed.success)
          return asApiError('Invalid Vault secret input.', 'invalid_request', 400);
        const rotated = backend.rotate({ referenceId, material: parsed.data.material });
        const result = advanceActiveVaultReferenceVersion(coreDb, {
          referenceId,
          currentVersion: rotated.currentVersion,
        });
        audit('succeeded');
        return c.json(projectReference(result));
      }
      backend.revoke({ referenceId });
      const result = revokeVaultReference(coreDb, { referenceId });
      audit('succeeded');
      return c.json(projectReference(result));
    } catch {
      if (storedReferenceId) {
        try {
          backend.revoke({ referenceId: storedReferenceId });
        } catch {
          /* Failed cleanup requires inspection. */
        }
      }
      audit('failed');
      return asApiError(
        'Vault mutation failed; inspect inventory before a new request.',
        'vault_mutation_failed',
        409
      );
    }
  }
  registerAppApiRoute(app, 'createWorkspaceVaultSecret', (c) => mutate(c, 'create'));
  registerAppApiRoute(app, 'rotateWorkspaceVaultSecret', (c) => mutate(c, 'rotate'));
  registerAppApiRoute(app, 'revokeWorkspaceVaultSecret', (c) => mutate(c, 'revoke'));
  registerAppApiRoute(app, 'createWorkspaceVaultGrant', (c) => mutate(c, 'grant'));
  registerAppApiRoute(app, 'revokeWorkspaceVaultGrant', (c) => mutate(c, 'revoke-grant'));
}

/** Select public metadata explicitly, excluding backend locators and display content. */
function projectReference(reference: NonNullable<ReturnType<typeof getVaultReference>>) {
  const { backendKind, currentVersion, ownerScope, referenceId, secretKind, status, workspaceId } =
    reference;
  return VaultAdminWorkspaceReferenceSchema.parse({
    backendKind,
    currentVersion,
    ownerScope,
    referenceId,
    secretKind,
    status,
    workspaceId,
  });
}
