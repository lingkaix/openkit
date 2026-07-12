import {
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  listExportableAgentEnvironmentPackageSnapshots,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';

/**
 * Registers Agent Environment Package snapshot read routes.
 *
 * @param dependencies Hono app and request-scoped storage dependencies.
 */
export function registerAgentEnvironmentRoutes({
  app,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'listAgentEnvironmentPackageSnapshots', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
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
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const record = requireAgentEnvironmentPackageSnapshot(workspaceDb, workspaceId, snapshotId);

        return c.json(GetAgentEnvironmentPackageSnapshotResponseSchema.parse(record));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'not_found', 404);
    }
  });
}
