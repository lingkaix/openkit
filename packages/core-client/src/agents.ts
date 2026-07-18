import {
  type AgentHealthRefreshResponse,
  AgentHealthRefreshResponseSchema,
  type GetAgentCatalogEntryResponse,
  GetAgentCatalogEntryResponseSchema,
  type ListAgentCatalogResponse,
  ListAgentCatalogResponseSchema,
} from '@openkit/app-api-schemas';
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

/**
 * Creates the product-facing Agent Catalog client.
 *
 * @param transport Shared Core Client transport.
 * @returns Agent Catalog operations backed directly by their public routes.
 */
export function createAgentCatalogClient(transport: ClientTransport): AgentCatalogClient {
  return {
    list: () => transport.getJson('/api/app/agents', ListAgentCatalogResponseSchema),
    get: (agentId) =>
      transport.getJson(
        `/api/app/agents/${encodeURIComponent(agentId)}`,
        GetAgentCatalogEntryResponseSchema
      ),
    refreshHealth: (workspaceId) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/agents/health/refresh`,
        {},
        AgentHealthRefreshResponseSchema
      ),
  };
}
