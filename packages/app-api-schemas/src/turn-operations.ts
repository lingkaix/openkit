import {
  InterruptTurnRequestSchema,
  ProductTurnSchema,
  SubmitTurnInputRequestSchema,
  ThreadIdSchema,
  TurnIdSchema,
  TurnReadProjectionSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { SubmitTurnFeedbackRequestSchema, TurnFeedbackResponseSchema } from './feedback.js';
import type { OperationDefinition } from './operation-contract.js';

/** Credentials already used by the public Workspace, Thread and Turn families. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

const workspaceSelector = { workspaceId: WorkspaceIdSchema };

const threadSelector = { ...workspaceSelector, threadId: ThreadIdSchema };

/** Turn commands, feedback and detail retain the lifecycle, product projection and Context Package evidence owners. */
export const TURN_OPERATION_DEFINITIONS = {
  'turn.start': {
    binding: 'json',
    returnsOneTimeSecret: false,
    description:
      'Admit one worker Turn in its addressed Thread; return before completion and replay its current owner.',
    inputSchema: SubmitTurnInputRequestSchema.strict(),
    outputSchema: ProductTurnSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'turn.run',
    mutating: true,
    successStatus: 202,
  },
  'turn.interrupt': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Interrupt one exact Turn in its addressed Thread.',
    inputSchema: InterruptTurnRequestSchema.extend({ ...threadSelector, turnId: TurnIdSchema }),
    outputSchema: ProductTurnSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: {
      kind: 'addressed-turn',
      lineage: 'turn',
      threadField: 'threadId',
      turnField: 'turnId',
      missing: 'interrupt-failed',
    },
    policyOperation: 'turn.run',
    mutating: true,
  },
  'turn.feedback': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description:
      'Update feedback for one opaque Turn under its current Workspace and Thread authority.',
    inputSchema: SubmitTurnFeedbackRequestSchema.extend({ turnId: TurnIdSchema }).strict(),
    outputSchema: TurnFeedbackResponseSchema,
    invalidInputCode: 'invalid_feedback',
    credentials: publicCredentials,
    scope: { kind: 'opaque-child-workspace', childOwner: 'turn', childField: 'turnId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'turn.read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one Turn in its visible Thread.',
    inputSchema: z.object({ ...threadSelector, turnId: TurnIdSchema }).strict(),
    outputSchema: TurnReadProjectionSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: {
      kind: 'addressed-turn',
      lineage: 'turn',
      threadField: 'threadId',
      turnField: 'turnId',
      missing: 'not-found',
    },
    policyOperation: 'thread.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
