import {
  ArchiveThreadRequestSchema,
  CreateWorkspaceRequestSchema,
  InterruptTurnRequestSchema,
  ListThreadsResponseSchema,
  ProductTurnSchema,
  SubmitTurnInputRequestSchema,
  ThreadIdSchema,
  ThreadSchema,
  TurnIdSchema,
  UpdateThreadRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceIdSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { WorkspaceDashboardResponseSchema } from './dashboard.js';
import { SubmitTurnFeedbackRequestSchema, TurnFeedbackResponseSchema } from './feedback.js';
import { QuickChatRequestSchema, QuickChatResponseSchema } from './quick-chat.js';

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;
const workspace = { workspaceId: WorkspaceIdSchema };
const thread = { ...workspace, threadId: ThreadIdSchema };
const scope = { kind: 'body-workspace', field: 'workspaceId' } as const;
const addressedThread = {
  kind: 'addressed-thread',
  threadField: 'threadId',
  missing: 'not-found',
} as const;

/** Sole contracts for the remaining Workspace, Thread, Turn commands and direct Quick Chat. */
export const CORE_COMMAND_OPERATION_DEFINITIONS = {
  'workspace.create': {
    description: 'Create one actor-owned Workspace with exact command replay.',
    inputSchema: CreateWorkspaceRequestSchema.strict(),
    outputSchema: WorkspaceRecordSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'user' },
    target: { kind: 'new-workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
    successStatus: 201,
  },
  'workspace.read': {
    description: 'Read one Workspace with viewer-visible counts.',
    inputSchema: z.object(workspace).strict(),
    outputSchema: WorkspaceRecordSchema,
    credentials,
    scope,
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'workspace.update': {
    description: 'Update one Workspace with exact command replay.',
    inputSchema: UpdateWorkspaceRequestSchema.extend(workspace).strict(),
    outputSchema: WorkspaceRecordSchema,
    credentials,
    scope,
    target: { kind: 'workspace' },
    policyOperation: 'workspace.lifecycle',
    mutating: true,
  },
  'workspace.dashboard': {
    description: 'Read one Workspace dashboard with viewer-visible work and artifacts.',
    inputSchema: z.object(workspace).strict(),
    outputSchema: WorkspaceDashboardResponseSchema,
    credentials,
    scope,
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'thread.list': {
    description: 'List visible Threads in one Workspace.',
    inputSchema: z.object(workspace).strict(),
    outputSchema: ListThreadsResponseSchema,
    credentials,
    scope,
    target: { kind: 'workspace' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.update': {
    description: 'Update one visible Thread with exact command replay.',
    inputSchema: UpdateThreadRequestSchema,
    outputSchema: ThreadSchema,
    credentials,
    scope,
    target: addressedThread,
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'thread.archive': {
    description: 'Archive one visible Thread and close out its pending requests.',
    inputSchema: ArchiveThreadRequestSchema,
    outputSchema: ThreadSchema,
    credentials,
    scope,
    target: addressedThread,
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'turn.start': {
    description:
      'Admit one worker Turn in its addressed Thread; return before completion and replay its current owner.',
    inputSchema: SubmitTurnInputRequestSchema.strict(),
    outputSchema: ProductTurnSchema,
    credentials,
    scope,
    target: addressedThread,
    policyOperation: 'turn.run',
    mutating: true,
    successStatus: 202,
  },
  'turn.interrupt': {
    description: 'Interrupt one exact Turn in its addressed Thread.',
    inputSchema: InterruptTurnRequestSchema.extend({ ...thread, turnId: TurnIdSchema }),
    outputSchema: ProductTurnSchema,
    credentials,
    scope,
    target: {
      kind: 'addressed-turn',
      threadField: 'threadId',
      turnField: 'turnId',
      missing: 'not-found',
    },
    policyOperation: 'turn.run',
    mutating: true,
  },
  'turn.feedback': {
    description:
      'Update feedback for one opaque Turn under its current Workspace and Thread authority.',
    inputSchema: SubmitTurnFeedbackRequestSchema.extend({ turnId: TurnIdSchema }).strict(),
    outputSchema: TurnFeedbackResponseSchema,
    inputErrorCode: 'invalid_feedback',
    credentials,
    scope: { kind: 'opaque-child-workspace', childField: 'turnId' },
    target: { kind: 'opaque-turn' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'chat.quick': {
    description: 'Run one completed non-streaming Quick Chat in the actor’s own Workspace.',
    inputSchema: QuickChatRequestSchema,
    outputSchema: QuickChatResponseSchema,
    credentials,
    scope: { kind: 'actor-quick-chat-workspace' },
    target: { kind: 'actor-quick-chat-workspace' },
    policyOperation: 'turn.run',
    mutating: true,
  },
} as const;
