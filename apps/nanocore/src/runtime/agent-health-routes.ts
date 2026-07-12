import { AgentHealthRefreshResponseSchema } from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import { findStoredAgentSessionById } from './agent-session-read-model.js';
import type { TurnExecutor } from './types.js';

/**
 * Registers the workspace agent-health refresh route.
 *
 * @param dependencies Hono app, request storage, runtime sessions, and config version getter.
 */
export function registerAgentHealthRoutes({
  app,
  requestStore,
  runtimeConfigVersion,
  turnExecutor,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly runtimeConfigVersion: () => number;
  readonly turnExecutor: TurnExecutor;
}): void {
  registerAppApiRoute(app, 'refreshAgentHealth', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);

      return c.json(
        AgentHealthRefreshResponseSchema.parse({
          items: store.refreshAgentHealth(workspaceId),
          sessions: (turnExecutor.refreshAgentSessions?.(store, workspaceId) ?? []).map(
            (session) => {
              const storedSession = findStoredAgentSessionById(store, workspaceId, session.id);
              const configVersion = storedSession?.configVersion ?? session.configVersion ?? null;

              return {
                ...session,
                configVersion,
                workspaceRoots: storedSession?.workspaceRoots ?? session.workspaceRoots ?? [],
                stale: configVersion !== null && configVersion < runtimeConfigVersion(),
              };
            }
          ),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'agent_health_refresh_failed');
    }
  });
}
