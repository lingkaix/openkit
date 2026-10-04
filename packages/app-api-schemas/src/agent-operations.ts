import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { GetAgentCatalogEntryResponseSchema, ListAgentCatalogResponseSchema } from './agents.js';
import { AgentHealthRefreshResponseSchema } from './dashboard.js';
import type { OperationDefinition } from './operation-contract.js';

/** Public credentials retain current Workspace admission and administrator eligibility. */
const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** Agent declarations reuse native payloads and closed admission strategies. */
export const AGENT_OPERATION_DEFINITIONS = {
  'agent.health-refresh': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Refresh the selected Workspace Agent health.',
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: AgentHealthRefreshResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'turn.run',
    mutating: true,
  },
  'agent.list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List product-visible Agents across authorized Workspaces.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListAgentCatalogResponseSchema,
    credentials,
    scope: { kind: 'authorized-workspace-set' },
    target: { kind: 'authorized-workspaces' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'agent.read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one product-visible Agent across authorized Workspaces.',
    inputSchema: z.object({ agentId: z.string().min(1) }).strict(),
    outputSchema: GetAgentCatalogEntryResponseSchema,
    credentials,
    scope: { kind: 'authorized-workspace-set' },
    target: { kind: 'authorized-workspaces' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
