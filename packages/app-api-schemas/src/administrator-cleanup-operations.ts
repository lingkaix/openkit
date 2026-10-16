import { z } from 'zod';
import { AdministratorCleanupReadResponseSchema } from './administrator-cleanup.js';
import type { OperationDefinition } from './operation-contract.js';

/** Current administrator-only observations; source owners retain all cleanup authority. */
export const ADMINISTRATOR_CLEANUP_OPERATION_DEFINITIONS = {
  'administration.cleanup-read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read bounded cleanup observations from current canonical records.',
    inputSchema: z.object({}).strict(),
    outputSchema: AdministratorCleanupReadResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'audit.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
