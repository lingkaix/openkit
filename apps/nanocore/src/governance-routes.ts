import {
  CapabilityUsageResponseSchema,
  type CreateEvidenceBundleRequest,
  CreateEvidenceBundleRequestSchema,
  CreateEvidenceBundleResponseSchema,
  type EvidenceBundleRef,
  ListServerAuditEventsResponseSchema,
  ListServerPermissionDecisionsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspaceInjectionPlansResponseSchema,
  ListWorkspaceInjectionReceiptsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceVaultGrantsResponseSchema,
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
import { createWorkspaceEvidenceBundle, listWorkspaceEvidenceBundles } from './evidence-bundles.js';
import { listExportableInjectionPlans } from './injection-plans.js';
import { listExportableInjectionReceipts } from './injection-receipts.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  listExportableWorkspacePermissionDecisions,
  listServerPermissionDecisions,
} from './policy/permission-decisions.js';
import { listWorkspaceRuntimeEvidence } from './runtime/runtime-evidence.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { listExportableWorkspaceVaultGrants } from './vault/vault-grants.js';

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
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'getCapabilityUsage', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

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

  registerAppApiRoute(app, 'createEvidenceBundle', async (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const input = CreateEvidenceBundleRequestSchema.parse(await c.req.json());
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          CreateEvidenceBundleResponseSchema.parse({
            evidenceBundle: createWorkspaceEvidenceBundle({
              workspaceDb,
              workspaceId,
              request: input,
              redactedEvidenceRefs: collectEvidenceBundleRefs(store, workspaceId, input),
            }),
          }),
          201
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
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

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
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

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
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

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
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

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

  registerAppApiRoute(app, 'listWorkspaceInjectionPlans', (c) => {
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
        ListWorkspaceInjectionPlansResponseSchema.parse({
          workspaceId,
          items: listExportableInjectionPlans(coreDb, grantIds),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceInjectionReceipts', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      requestStore(c).getWorkspace(workspaceId);

      if (!coreDb) {
        return asApiError('Core DB is not available.');
      }

      const grantIds = listExportableWorkspaceVaultGrants(coreDb, workspaceId).map(
        (grant) => grant.grantId
      );
      const planIds = listExportableInjectionPlans(coreDb, grantIds).map((plan) => plan.planId);
      return c.json(
        ListWorkspaceInjectionReceiptsResponseSchema.parse({
          workspaceId,
          items: listExportableInjectionReceipts(coreDb, planIds),
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

/**
 * Collects product-safe evidence references for one compact bundle.
 *
 * @param store App store that owns app-local thread and artifact records.
 * @param workspaceId Workspace that owns the bundle.
 * @param input Bundle lineage input.
 * @returns Product-safe record references only.
 */
function collectEvidenceBundleRefs(
  store: FsStore,
  workspaceId: string,
  input: CreateEvidenceBundleRequest
): EvidenceBundleRef[] {
  const refs: EvidenceBundleRef[] = [{ kind: 'workspace', ref: workspaceId }];

  if (input.threadId) {
    store.getThread(workspaceId, input.threadId);
    refs.push({ kind: 'thread', ref: input.threadId });
  }

  if (input.turnId) {
    if (input.threadId) {
      store.getTurn(workspaceId, input.threadId, input.turnId);
    }
    refs.push({ kind: 'turn', ref: input.turnId });
  }

  if (input.goalId) {
    refs.push({ kind: 'goal', ref: input.goalId });
  }

  for (const artifact of store.listArtifacts(workspaceId)) {
    if (input.threadId && artifact.threadId !== input.threadId) {
      continue;
    }
    if (input.turnId && artifact.turnId !== input.turnId) {
      continue;
    }
    refs.push({ kind: 'artifact', ref: artifact.id });
  }

  return refs;
}
