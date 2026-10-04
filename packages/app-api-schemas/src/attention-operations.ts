import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { ListHumanAttentionResponseSchema } from './action-center.js';
import type { OperationDefinition } from './operation-contract.js';

/** Credentials already used by the public Workspace, Thread and Turn families. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

const workspaceSelector = { workspaceId: WorkspaceIdSchema };

/** Action Center remains the single projection of human attention. */
export const ATTENTION_OPERATION_DEFINITIONS = {
  'attention.list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List unified human-attention rows for one Workspace.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: ListHumanAttentionResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
