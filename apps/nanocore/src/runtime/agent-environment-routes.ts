import {
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
} from '@openkit/app-api-schemas';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from '../auth/operation-authorizer.js';
import { registerAppApiRoute } from '../openapi.js';
import type { WorkspaceDb } from '../storage/db.js';
import { listExportableAgentEnvironmentPackageSnapshots } from './aep-snapshot-ledger.js';

/**
 * Registers Agent Environment Package snapshot read routes.
 *
 * @param dependencies Hono app and request-scoped storage dependencies.
 */
export function registerAgentEnvironmentRoutes({
  app,
  repositoryWorkspaceDb,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
}): void {
  registerAppApiRoute(app, 'listAgentEnvironmentPackageSnapshots', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const items = listExportableAgentEnvironmentPackageSnapshots(workspaceDb, workspaceId);

        return c.json(ListAgentEnvironmentPackageSnapshotsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'getAgentEnvironmentPackageSnapshot', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const snapshotId = c.req.param('snapshotId');
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      let record: ReturnType<typeof listExportableAgentEnvironmentPackageSnapshots>[number] | null;
      try {
        record =
          listExportableAgentEnvironmentPackageSnapshots(workspaceDb, workspaceId).find(
            (candidate) => candidate.snapshotId === snapshotId
          ) ?? null;
      } finally {
        workspaceDb.sqlite.close();
      }
      assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), record?.workspaceId ?? null);

      return c.json(GetAgentEnvironmentPackageSnapshotResponseSchema.parse(record));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asApiError((error as Error).message, 'not_found', 404);
    }
  });
}
