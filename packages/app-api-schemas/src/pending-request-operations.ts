import {
  AnswerUserInputRequestSchema,
  ApprovalRequestSchema,
  PendingRequestOutcomeSchema,
  RespondToApprovalRequestSchema,
  WithdrawPendingRequestSchema,
} from '@openkit/protocol';
import type { OperationDefinition } from './operation-contract.js';

/** Credentials already used by the public Workspace, Thread and Turn families. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** Decisions join the shared Pending Request owner; CLI semantic ids stay unchanged. */
export const PENDING_REQUEST_OPERATION_DEFINITIONS = {
  'approval.respond': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Respond to one approval request.',
    inputSchema: RespondToApprovalRequestSchema,
    outputSchema: ApprovalRequestSchema,
    credentials: publicCredentials,
    scope: {
      kind: 'opaque-child-workspace',
      childOwner: 'pending-request',
      field: 'workspaceId',
      childField: 'approvalRequestId',
    },
    target: { kind: 'workspace' },
    policyOperation: 'approval.respond',
    mutating: true,
  },
  'question.answer': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Submit the responsible user’s answer to one pending non-secret question.',
    inputSchema: AnswerUserInputRequestSchema,
    outputSchema: PendingRequestOutcomeSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId' },
    policyOperation: 'approval.respond',
    mutating: true,
  },
  'pending-request.withdraw': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Withdraw one pending request under an explicit human decision.',
    inputSchema: WithdrawPendingRequestSchema,
    outputSchema: PendingRequestOutcomeSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId' },
    policyOperation: 'approval.respond',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
