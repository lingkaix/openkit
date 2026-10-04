import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';
import { WorkspaceWorkersResponseSchema } from './workers.js';

/** Public credentials retain current Workspace admission and administrator eligibility. */
const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** Worker declarations reuse native payloads and closed admission strategies. */
export const WORKER_OPERATION_DEFINITIONS = {
  'worker.list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read current Workers visible in the selected Workspace.',
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: WorkspaceWorkersResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
