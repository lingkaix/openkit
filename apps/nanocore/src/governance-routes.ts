import {
  CapabilityUsageResponseSchema,
  ListServerAuditEventsResponseSchema,
  ListServerPermissionDecisionsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceVaultGrantsResponseSchema,
  ListWorkspaceVaultInjectionPlansResponseSchema,
  ListWorkspaceVaultInjectionReceiptsResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from './api-errors.js';
import { listServerAuditEvents, listWorkspaceAuditEvents } from './audit-events.js';
import { isDeploymentAdminActor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from './capability/usage-ledger.js';
import { listWorkspaceEvidenceBundles } from './evidence-bundles.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  listExportableWorkspacePermissionDecisions,
  listServerPermissionDecisions,
} from './policy/permission-decisions.js';
import { listWorkspaceRuntimeEvidence } from './runtime/runtime-evidence.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { listExportableWorkspaceVaultGrants } from './vault/vault-grants.js';
import { listExportableVaultInjectionPlans } from './vault-injection-plans.js';
import { listExportableVaultInjectionReceipts } from './vault-injection-receipts.js';

/**
 * Requires deployment-admin authority for a server-owned governance projection.
 *
 * @param c Hono context carrying the authenticated actor.
 * @param code Stable route-specific authorization error code.
 * @returns Error response when the actor lacks deployment-admin authority.
 */
function requireServerGovernanceAdminActor(
  c: Context<{ Variables: AuthVariables }>,
  code: string
): Response | null {
  return isDeploymentAdminActor(c.get('actor'))
    ? null
    : asApiError('Server-admin authority is required.', code, 403);
}

/**
 * Registers product-safe capability, evidence, audit, permission, and vault governance routes.
 *
 * @param dependencies Hono app and governance storage dependencies.
 */
export function registerGovernanceRoutes({
  app,
  coreDb,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'getCapabilityUsage', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(workspaceId);

      try {
        return c.json(
          CapabilityUsageResponseSchema.parse({
            workspaceId,
            capabilityCalls: listWorkspaceCapabilityCalls(workspaceDb, workspaceId),
            usageRecords: listWorkspaceUsageRecords(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceEvidenceBundles', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(workspaceId);

      try {
        return c.json(
          ListWorkspaceEvidenceBundlesResponseSchema.parse({
            workspaceId,
            evidenceBundles: listWorkspaceEvidenceBundles(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceRuntimeEvidence', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(workspaceId);

      try {
        return c.json(
          ListWorkspaceRuntimeEvidenceResponseSchema.parse({
            workspaceId,
            runtimeEvidence: listWorkspaceRuntimeEvidence(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceAuditEvents', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(workspaceId);

      try {
        return c.json(
          ListWorkspaceAuditEventsResponseSchema.parse({
            workspaceId,
            auditEvents: listWorkspaceAuditEvents(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listServerAuditEvents', (c) => {
    const adminError = requireServerGovernanceAdminActor(c, 'server_audit_admin_forbidden');
    if (adminError) {
      return adminError;
    }

    try {
      if (!coreDb) {
        return asApiError(
          'Server audit storage is unavailable for this NanoCore instance.',
          'server_audit_storage_unavailable',
          503
        );
      }

      return c.json(
        ListServerAuditEventsResponseSchema.parse({
          auditEvents: listServerAuditEvents(coreDb),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspacePermissionDecisions', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(workspaceId);

      try {
        return c.json(
          ListWorkspacePermissionDecisionsResponseSchema.parse({
            workspaceId,
            permissionDecisions: listExportableWorkspacePermissionDecisions(
              workspaceDb,
              workspaceId
            ),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceVaultGrants', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      requestStore(c).getWorkspace(workspaceId);

      if (!coreDb) {
        return asApiError('Core DB is not available.');
      }

      return c.json(
        ListWorkspaceVaultGrantsResponseSchema.parse({
          workspaceId,
          items: listExportableWorkspaceVaultGrants(coreDb, workspaceId),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceVaultInjectionPlans', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      requestStore(c).getWorkspace(workspaceId);

      if (!coreDb) {
        return asApiError('Core DB is not available.');
      }

      const grantIds = listExportableWorkspaceVaultGrants(coreDb, workspaceId).map(
        (grant) => grant.grantId
      );
      return c.json(
        ListWorkspaceVaultInjectionPlansResponseSchema.parse({
          workspaceId,
          items: listExportableVaultInjectionPlans(coreDb, grantIds),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceVaultInjectionReceipts', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      requestStore(c).getWorkspace(workspaceId);

      if (!coreDb) {
        return asApiError('Core DB is not available.');
      }

      const grantIds = listExportableWorkspaceVaultGrants(coreDb, workspaceId).map(
        (grant) => grant.grantId
      );
      const planIds = listExportableVaultInjectionPlans(coreDb, grantIds).map(
        (plan) => plan.planId
      );
      return c.json(
        ListWorkspaceVaultInjectionReceiptsResponseSchema.parse({
          workspaceId,
          items: listExportableVaultInjectionReceipts(coreDb, planIds),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listServerPermissionDecisions', (c) => {
    const adminError = requireServerGovernanceAdminActor(
      c,
      'server_permission_decisions_admin_forbidden'
    );
    if (adminError) {
      return adminError;
    }

    try {
      if (!coreDb) {
        return asApiError('Core DB is not available.');
      }

      return c.json(
        ListServerPermissionDecisionsResponseSchema.parse({
          permissionDecisions: listServerPermissionDecisions(coreDb),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });
}
