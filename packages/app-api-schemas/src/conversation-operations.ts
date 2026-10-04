import { ThreadIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  ConversationTargetCatalogSchema,
  SubmitConversationRequestSchema,
  SubmitConversationResponseSchema,
} from './chat-mode.js';
import { ConversationNavigationResponseSchema } from './dashboard.js';
import type { OperationDefinition } from './operation-contract.js';
import { QuickChatRequestSchema, QuickChatResponseSchema } from './quick-chat.js';
import { StartTaskModeRequestSchema, StartTaskModeResponseSchema } from './task-mode.js';

/** Credentials already used by the public Workspace, Thread and Turn families. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

const workspaceSelector = { workspaceId: WorkspaceIdSchema };

const threadSelector = { ...workspaceSelector, threadId: ThreadIdSchema };

/** Conversation discovery, submission and Quick Chat preserve their existing bounded domain owners. */
export const CONVERSATION_OPERATION_DEFINITIONS = {
  'chat.quick': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Run one completed non-streaming Quick Chat in the actor’s own Workspace.',
    inputSchema: QuickChatRequestSchema,
    outputSchema: QuickChatResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'actor-quick-chat-workspace' },
    target: { kind: 'workspace' },
    policyOperation: 'turn.run',
    mutating: true,
  },
  'conversation.targets': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List context-sensitive conversation targets.',
    inputSchema: z.object({ ...workspaceSelector, threadId: ThreadIdSchema.optional() }).strict(),
    outputSchema: ConversationTargetCatalogSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'optional-addressed-thread', threadField: 'threadId' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'conversation.navigation': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List visible Workspace conversation activity for navigation.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: ConversationNavigationResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'conversation.submit': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Submit one structured conversation turn.',
    inputSchema: SubmitConversationRequestSchema.safeExtend(threadSelector),
    outputSchema: SubmitConversationResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId' },
    policyOperation: 'turn.run',
    mutating: true,
    successStatuses: [200, 202],
  },
} as const satisfies Record<string, OperationDefinition>;

/** Ordinary bounded Task admission and replay, without a new Task lifecycle. */
export const TASK_OPERATION_DEFINITIONS = {
  'task.start': {
    binding: 'json',
    returnsOneTimeSecret: false,
    description: 'Start one bounded Task Mode delegation.',
    inputSchema: StartTaskModeRequestSchema.extend(threadSelector),
    outputSchema: StartTaskModeResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId' },
    policyOperation: 'turn.run',
    mutating: true,
    successStatus: 202,
  },
} as const satisfies Record<string, OperationDefinition>;
