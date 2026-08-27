import { AgentHealthRefreshResponseSchema } from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';

/**
 * Registers the workspace agent-health refresh route.
 *
 * @param dependencies Hono app and request storage.
 */
export function registerAgentHealthRoutes({
  app,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'refreshAgentHealth', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);

      return c.json(
        AgentHealthRefreshResponseSchema.parse({
          items: store.refreshAgentHealth(workspaceId),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'agent_health_refresh_failed');
    }
  });
}
