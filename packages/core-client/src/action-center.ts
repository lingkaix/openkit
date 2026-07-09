import {
  type ListHumanAttentionResponse,
  ListHumanAttentionResponseSchema,
} from '@openkit/app-api-schemas';
import type { ClientTransport } from './transport.js';

/** Product-facing Action Center client. */
export interface ActionCenterClient {
  /** Lists unified human attention rows for one workspace. */
  listHumanAttention(workspaceId: string): Promise<ListHumanAttentionResponse>;
}

/** Creates the Product-facing Action Center client. */
export function createActionCenterClient(transport: ClientTransport): ActionCenterClient {
  return {
    listHumanAttention: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/action-center`,
        ListHumanAttentionResponseSchema
      ),
  };
}
