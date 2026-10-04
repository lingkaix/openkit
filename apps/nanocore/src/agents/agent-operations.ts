import type { AGENT_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { StoreRecordNotFoundError } from '../lib/store.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import type { FamilyImplementations } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';

/** Joins candidate-first Agent reads and health refresh to the existing live Workspace catalog owner. */
export function createAgentOperationImplementations({ store }: OperationInvocationDependencies) {
  const owner = store!;
  const resources = (workspaceId: string) => {
    try {
      return owner.getWorkspaceResources(workspaceId);
    } catch (error) {
      if (error instanceof StoreRecordNotFoundError)
        throw new OperationError('not_found', error.message, 404, { cause: error });
      throw error;
    }
  };
  return {
    'agent.list': (_input, context) => {
      if (context.scope.kind !== 'authorized-workspace-set')
        throw new Error('Agent catalog requires admitted Workspace candidates.');
      const agents = new Map<
        string,
        ReturnType<typeof owner.getWorkspaceResources>['agents'][number]
      >();
      for (const workspaceId of context.scope.workspaceIds) {
        for (const agent of resources(workspaceId).agents) {
          if (!agents.has(agent.id)) agents.set(agent.id, agent);
        }
      }
      // The definition's product schema removes adapter-native configuration.
      return { items: [...agents.values()] };
    },
    'agent.read': ({ agentId }, context) => {
      if (context.scope.kind !== 'authorized-workspace-set')
        throw new Error('Agent catalog requires admitted Workspace candidates.');
      for (const workspaceId of context.scope.workspaceIds) {
        const agent = resources(workspaceId).agents.find((candidate) => candidate.id === agentId);
        if (agent) return agent;
      }
      throw new OperationError('not_found', `Agent not found: ${agentId}`, 404);
    },
    'agent.health-refresh': ({ workspaceId }) => {
      try {
        return { items: owner.refreshAgentHealth(workspaceId) };
      } catch (error) {
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('agent_health_refresh_failed', error.message, 404, {
            cause: error,
          });
        throw error;
      }
    },
  } satisfies FamilyImplementations<typeof AGENT_OPERATION_DEFINITIONS>;
}
