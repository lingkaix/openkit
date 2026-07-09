import {
  type AgentHealthRefreshResponse,
  type GetAgentCatalogEntryResponse,
  GetAgentCatalogEntryResponseSchema,
  type ListAgentCatalogResponse,
  ListAgentCatalogResponseSchema,
} from '@openkit/app-api-schemas';
import type { AppApiClient } from './app.js';
import type { ClientTransport } from './transport.js';

/** Product-facing Agent Catalog client. */
export interface AgentCatalogClient {
  /** Lists product-visible agents. */
  list(): Promise<ListAgentCatalogResponse>;
  /** Reads one product-visible agent catalog entry. */
  get(agentId: string): Promise<GetAgentCatalogEntryResponse>;
  /** Refreshes agent health for one workspace. */
  refreshHealth(workspaceId: string): Promise<AgentHealthRefreshResponse>;
}

/** Creates the Product-facing Agent Catalog client. */
export function createAgentCatalogClient(
  transport: ClientTransport,
  app: AppApiClient
): AgentCatalogClient {
  return {
    list: () => transport.getJson('/api/app/agents', ListAgentCatalogResponseSchema),
    get: (agentId) =>
      transport.getJson(
        `/api/app/agents/${encodeURIComponent(agentId)}`,
        GetAgentCatalogEntryResponseSchema
      ),
    refreshHealth: (workspaceId) => app.refreshAgentHealth(workspaceId),
  };
}
