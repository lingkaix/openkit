import { ThreadIdSchema, TurnIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  ListInterruptedWorkerStatesResponseSchema,
  RetryInterruptedWorkerCheckpointRequestSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
} from './dashboard.js';
import type { OperationDefinition } from './operation-contract.js';

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;
/** Recovery projection retains the original attempt and exact request identity. */
export const RECOVERY_OPERATION_DEFINITIONS = {
  'recovery.worker-list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List interrupted worker states in authorized Workspaces.',
    credentials,
    scope: { kind: 'authorized-workspace-set' },
    target: { kind: 'authorized-workspaces' },
    policyOperation: 'workspace.read',
    mutating: false,
    inputSchema: z.object({}).strict(),
    outputSchema: ListInterruptedWorkerStatesResponseSchema,
  },
  'recovery.checkpoint-retry': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Release one interrupted worker attempt for a later fresh start.',
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: {
      kind: 'addressed-turn',
      lineage: 'recovery-checkpoint',
      threadField: 'threadId',
      turnField: 'turnId',
    },
    policyOperation: 'turn.run',
    mutating: true,
    inputSchema: RetryInterruptedWorkerCheckpointRequestSchema.extend({
      workspaceId: WorkspaceIdSchema,
      threadId: ThreadIdSchema,
      turnId: TurnIdSchema,
    }),
    outputSchema: RetryInterruptedWorkerCheckpointResponseSchema,
  },
} as const satisfies Record<string, OperationDefinition>;
