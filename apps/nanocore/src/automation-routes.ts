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
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly automationStore: AutomationStore;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'listAutomations', (c) =>
    c.json(ListAutomationsResponseSchema.parse({ items: automationStore.listAutomations() }))
  );

  registerAppApiRoute(app, 'createAutomation', async (c) => {
    const input = CreateAutomationRequestSchema.parse(await c.req.json());
    requestStore(c).getWorkspace(input.workspaceId);
    return c.json(AutomationRecordSchema.parse(automationStore.createAutomation(input)), 201);
  });

  registerAppApiRoute(app, 'updateAutomation', async (c) => {
    try {
      const input = UpdateAutomationRequestSchema.parse(await c.req.json());

      return c.json(
        AutomationRecordSchema.parse(
          automationStore.updateAutomation(c.req.param('automationId'), input)
        )
      );
    } catch (error) {
      return asApiError((error as Error).message, 'automation_update_failed');
    }
  });

  registerAppApiRoute(app, 'deleteAutomation', (c) => {
    try {
      automationStore.deleteAutomation(c.req.param('automationId'));

      return c.body(null, 204);
    } catch (error) {
      return asApiError((error as Error).message, 'automation_delete_failed');
    }
  });
}
