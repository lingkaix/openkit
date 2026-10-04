import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  CancelSchedulerAdmissionResponseSchema,
  ListSchedulerAdmissionsResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
} from './dashboard.js';
import type { OperationDefinition } from './operation-contract.js';

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;
const scope = { kind: 'body-workspace', field: 'workspaceId' } as const;
const selectors = { workspaceId: WorkspaceIdSchema, queueEntryId: z.string().min(1) };
const mutation = {
  credentials,
  scope,
  target: { kind: 'scheduler-admission', field: 'queueEntryId' },
  policyOperation: 'turn.run',
  mutating: true,
  inputSchema: z.object(selectors).strict(),
} as const;
/** Public scheduler admission views and actions; queue lifecycle remains with NanoCore. */
export const SCHEDULER_OPERATION_DEFINITIONS = {
  'scheduler.list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List queued and denied admissions for one Workspace.',
    credentials,
    scope,
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: ListSchedulerAdmissionsResponseSchema,
  },
  'scheduler.retry': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...mutation,
    description: 'Retry one denied scheduler admission.',
    outputSchema: RetrySchedulerAdmissionResponseSchema,
  },
  'scheduler.cancel': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...mutation,
    description: 'Cancel one queued or denied scheduler admission.',
    outputSchema: CancelSchedulerAdmissionResponseSchema,
  },
} as const satisfies Record<string, OperationDefinition>;
