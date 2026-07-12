import {
  CreateWorkspaceRequestSchema,
  ListWorkspacesResponseSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesResponseSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb } from './storage/db.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Registers the Core workspace lifecycle routes.
 *
 * @param dependencies Hono app, workspace storage, visibility policy, and Core membership storage.
 */
export function registerWorkspaceRoutes({
  app,
  coreDb,
  inflightCommands,
  requestStore,
  visibleWorkspacesForActor,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly visibleWorkspacesForActor: (
    actor: AuthVariables['actor'] | undefined,
    items: ReturnType<FsStore['listWorkspaces']>
  ) => ReturnType<FsStore['listWorkspaces']>;
}): void {
  app.get('/api/workspaces', (c) => {
    try {
      const items = visibleWorkspacesForActor(c.get('actor'), requestStore(c).listWorkspaces());

      return c.json(ListWorkspacesResponseSchema.parse({ items }));
    } catch (error) {
      return asApiError((error as Error).message, 'workspace_list_failed', 500);
    }
  });

  app.post('/api/workspaces', async (c) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspace = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'workspace.create',
        requestId: parsed.data.requestId,
        scope: {},
        input: parsed.data,
        responseKind: 'workspace',
        execute: () => {
          const workspace = WorkspaceRecordSchema.parse(store.createWorkspace(parsed.data.name));
          if (coreDb) {
            recordWorkspaceOwnerMembership({
              coreDb,
              ownerUserId: c.get('actor').userId,
              workspaceId: workspace.id,
            });
          }

          return workspace;
        },
        replay: (record) => WorkspaceRecordSchema.parse(store.getWorkspace(record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(workspace, 201);
    } catch (error) {
      return asCommandError(error, 'workspace_create_failed');
    }
  });

  app.get('/api/workspaces/:workspaceId', (c) => {
    try {
      return c.json(
        WorkspaceRecordSchema.parse(requestStore(c).getWorkspace(c.req.param('workspaceId')))
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/resources', (c) => {
    try {
      return c.json(
        WorkspaceResourcesResponseSchema.parse(
          requestStore(c).getWorkspaceResources(c.req.param('workspaceId'))
        )
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.patch('/api/workspaces/:workspaceId', async (c) => {
    const parsed = UpdateWorkspaceRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspace = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'workspace.update',
        requestId: parsed.data.requestId,
        scope: { workspaceId },
        input: { ...parsed.data, workspaceId },
        responseKind: 'workspace',
        execute: () => WorkspaceRecordSchema.parse(store.updateWorkspace(workspaceId, parsed.data)),
        replay: (record) => WorkspaceRecordSchema.parse(store.getWorkspace(record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(workspace);
    } catch (error) {
      return asCommandError(error, 'workspace_update_failed');
    }
  });
}
