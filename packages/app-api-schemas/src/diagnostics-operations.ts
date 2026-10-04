import { z } from 'zod';
import { AppDiagnosticsResponseSchema, SetupDiagnosticsResponseSchema } from './diagnostics.js';
import type { OperationDefinition } from './operation-contract.js';

/** Product diagnostics retain current administrator admission; support probes stay outside this table. */
export const DIAGNOSTICS_OPERATION_DEFINITIONS = {
  'diagnostics.app': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read application runtime diagnostics.',
    inputSchema: z.object({}).strict(),
    outputSchema: AppDiagnosticsResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'api.call',
    mutating: false,
  },
  'diagnostics.setup': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read setup diagnostics.',
    inputSchema: z.object({}).strict(),
    outputSchema: SetupDiagnosticsResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'api.call',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
