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
 * @param dependencies Hono app, automation storage, Workspace authorization, and shared storage.
 */
export function registerAutomationRoutes({
  app,
  authorizedWorkspaceIds,
  automationStore,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly authorizedWorkspaceIds: (
    context: Context<{ Variables: AuthVariables }>
  ) => readonly string[];
  readonly automationStore: AutomationStore;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  /**
   * Opens and returns only Workspace ids authorized for the current actor.
   *
   * @param c Authenticated request context.
   * @param store Shared Workspace store.
   * @returns Authorized Workspace ids present in the shared store.
   */
  function visibleWorkspaceIds(
    c: Context<{ Variables: AuthVariables }>,
    store: FsStore
  ): Set<string> {
    return new Set(
      authorizedWorkspaceIds(c).map((workspaceId) => store.getWorkspace(workspaceId).id)
    );
  }

  registerAppApiRoute(app, 'listAutomations', (c) => {
    const store = requestStore(c);
    const userId = c.get('actor').userId;
    const workspaceIds = visibleWorkspaceIds(c, store);
    const items = automationStore
      .listAutomations(userId)
      .filter((automation) => workspaceIds.has(automation.workspaceId));

    return c.json(ListAutomationsResponseSchema.parse({ items }));
  });

  registerAppApiRoute(app, 'createAutomation', async (c) => {
    const input = CreateAutomationRequestSchema.parse(await c.req.json());
    const store = requestStore(c);
    const userId = c.get('actor').userId;

    if (!visibleWorkspaceIds(c, store).has(input.workspaceId)) {
      return asApiError('Workspace is unavailable.', 'automation_create_failed');
    }

    return c.json(
      AutomationRecordSchema.parse(automationStore.createAutomation(userId, input)),
      201
    );
  });

  registerAppApiRoute(app, 'updateAutomation', async (c) => {
    try {
      const input = UpdateAutomationRequestSchema.parse(await c.req.json());
      const store = requestStore(c);
      const userId = c.get('actor').userId;
      const automationId = c.req.param('automationId');
      const automation = automationStore.getAutomation(userId, automationId);

      if (!visibleWorkspaceIds(c, store).has(automation.workspaceId)) {
        throw new Error(`Automation not found: ${automationId}`);
      }

      return c.json(
        AutomationRecordSchema.parse(automationStore.updateAutomation(userId, automationId, input))
      );
    } catch (error) {
      return asApiError((error as Error).message, 'automation_update_failed');
    }
  });

  registerAppApiRoute(app, 'deleteAutomation', (c) => {
    try {
      const store = requestStore(c);
      const userId = c.get('actor').userId;
      const automationId = c.req.param('automationId');
      const automation = automationStore.getAutomation(userId, automationId);

      if (!visibleWorkspaceIds(c, store).has(automation.workspaceId)) {
        throw new Error(`Automation not found: ${automationId}`);
      }

      automationStore.deleteAutomation(userId, automationId);

      return c.body(null, 204);
    } catch (error) {
      return asApiError((error as Error).message, 'automation_delete_failed');
    }
  });
}
