import {
  AutomationRecordSchema,
  CreateAutomationRequestSchema,
  ListAutomationsResponseSchema,
  UpdateAutomationRequestSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { AutomationStore } from './lib/automation-store.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';

/**
 * Registers automation definition list, create, update, and delete routes.
 *
 * @param dependencies Hono app, automation storage, and request-scoped workspace storage.
 */
export function registerAutomationRoutes({
  app,
  automationStore,
  requestStore,
  visibleWorkspacesForActor,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly automationStore: AutomationStore;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly visibleWorkspacesForActor: (
    actor: AuthVariables['actor'] | undefined,
    items: ReturnType<FsStore['listWorkspaces']>
  ) => ReturnType<FsStore['listWorkspaces']>;
}): void {
  /**
   * Returns workspace ids visible to the current actor.
   *
   * @param c Authenticated request context.
   * @param store Actor-owned workspace store.
   * @returns Workspace ids the actor may see.
   */
  function visibleWorkspaceIds(
    c: Context<{ Variables: AuthVariables }>,
    store: FsStore
  ): Set<string> {
    return new Set(
      visibleWorkspacesForActor(c.get('actor'), store.listWorkspaces()).map(
        (workspace) => workspace.id
      )
    );
  }

  registerAppApiRoute(app, 'listAutomations', (c) => {
    const store = requestStore(c);
    const workspaceIds = visibleWorkspaceIds(c, store);
    const items = automationStore
      .listAutomations(store.getUserId())
      .filter((automation) => workspaceIds.has(automation.workspaceId));

    return c.json(ListAutomationsResponseSchema.parse({ items }));
  });

  registerAppApiRoute(app, 'createAutomation', async (c) => {
    const input = CreateAutomationRequestSchema.parse(await c.req.json());
    const store = requestStore(c);

    store.getWorkspace(input.workspaceId);
    if (!visibleWorkspaceIds(c, store).has(input.workspaceId)) {
      return asApiError('Workspace is unavailable.', 'automation_create_failed');
    }

    return c.json(
      AutomationRecordSchema.parse(automationStore.createAutomation(store.getUserId(), input)),
      201
    );
  });

  registerAppApiRoute(app, 'updateAutomation', async (c) => {
    try {
      const input = UpdateAutomationRequestSchema.parse(await c.req.json());
      const store = requestStore(c);
      const automationId = c.req.param('automationId');
      const automation = automationStore.getAutomation(store.getUserId(), automationId);

      if (!visibleWorkspaceIds(c, store).has(automation.workspaceId)) {
        throw new Error(`Automation not found: ${automationId}`);
      }

      return c.json(
        AutomationRecordSchema.parse(
          automationStore.updateAutomation(store.getUserId(), automationId, input)
        )
      );
    } catch (error) {
      return asApiError((error as Error).message, 'automation_update_failed');
    }
  });

  registerAppApiRoute(app, 'deleteAutomation', (c) => {
    try {
      const store = requestStore(c);
      const automationId = c.req.param('automationId');
      const automation = automationStore.getAutomation(store.getUserId(), automationId);

      if (!visibleWorkspaceIds(c, store).has(automation.workspaceId)) {
        throw new Error(`Automation not found: ${automationId}`);
      }

      automationStore.deleteAutomation(store.getUserId(), automationId);

      return c.body(null, 204);
    } catch (error) {
      return asApiError((error as Error).message, 'automation_delete_failed');
    }
  });
}
