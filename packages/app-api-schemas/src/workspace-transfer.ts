import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';
import { WorkspaceExportResponseSchema } from './storage.js';

const canonicalUserCredentials = [
  'local-user',
  'user-session',
  'deployment-administrator',
] as const;

/** Server-managed JSON portability handles; binary archive bindings retain their own owner. */
export const WORKSPACE_TRANSFER_OPERATION_DEFINITIONS = {
  'workspace.export': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Create and verify one server-managed Workspace export.',
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: WorkspaceExportResponseSchema,
    credentials: [...canonicalUserCredentials, 'user-bearer'],
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.export',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
