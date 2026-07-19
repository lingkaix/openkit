import {
  GetAgentCatalogEntryResponseSchema,
  ListAgentCatalogResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';

/**
 * Removes adapter-native runtime config from an agent catalog row.
 *
 * @param agent Runtime agent read model.
 * @returns App API agent catalog entry.
 */
function appAgentCatalogEntry(agent: unknown): unknown {
  const { config: _config, ...catalogEntry } = agent as Record<string, unknown>;

  return GetAgentCatalogEntryResponseSchema.parse(catalogEntry);
}

/**
 * Lists unique product-visible agent catalog entries across accessible workspaces.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceIds Workspace ids authorized for the current request.
 * @returns Agent catalog response payload.
 */
function listAgentCatalog(store: FsStore, workspaceIds: readonly string[]): unknown {
  const agents = new Map<string, unknown>();

  for (const workspaceId of workspaceIds) {
    for (const agent of store.getWorkspaceResources(workspaceId).agents) {
      if (!agents.has(agent.id)) {
        agents.set(agent.id, appAgentCatalogEntry(agent));
      }
    }
  }

  return ListAgentCatalogResponseSchema.parse({ items: [...agents.values()] });
}

/**
 * Reads one product-visible agent catalog entry across accessible workspaces.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceIds Workspace ids authorized for the current request.
 * @param agentId Agent id to read.
 * @returns Agent catalog entry.
 */
function getAgentCatalogEntry(
  store: FsStore,
  workspaceIds: readonly string[],
  agentId: string
): unknown {
  for (const workspaceId of workspaceIds) {
    const agent = store
      .getWorkspaceResources(workspaceId)
      .agents.find((candidate) => candidate.id === agentId);

    if (agent) {
      return appAgentCatalogEntry(agent);
    }
  }

  throw new Error(`Agent not found: ${agentId}`);
}

/**
 * Registers product-visible Agent Catalog read routes.
 *
 * @param dependencies Hono app and request-scoped storage resolver.
 */
export function registerAgentCatalogRoutes({
  app,
  authorizedWorkspaceIds,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly authorizedWorkspaceIds: (
    context: Context<{ Variables: AuthVariables }>
  ) => readonly string[];
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'listAgentCatalog', (c) => {
    try {
      const store = requestStore(c);

      return c.json(listAgentCatalog(store, authorizedWorkspaceIds(c)));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'getAgentCatalogEntry', (c) => {
    try {
      const store = requestStore(c);

      return c.json(getAgentCatalogEntry(store, authorizedWorkspaceIds(c), c.req.param('agentId')));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });
}
