import { ReadCallerRequestSchema, ReadCallerResponseSchema } from './caller.js';
import type { OperationDefinition } from './operation-contract.js';

/** Current-caller read reuses canonical-user admission and current Workspace source audiences. */
export const CALLER_OPERATION_DEFINITIONS = {
  'caller.read': {
    description: 'Read current caller identity and optional owned Workspace retained-work counts.',
    inputSchema: ReadCallerRequestSchema,
    outputSchema: ReadCallerResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'user' },
    target: { kind: 'user' },
    policyOperation: 'api.call',
    mutating: false,
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
  },
} as const satisfies Record<string, OperationDefinition>;
