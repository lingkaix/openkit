import { ThreadIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  CONVERSATION_FILE_MEDIA_TYPE,
  ConversationTargetCatalogSchema,
  SubmitConversationRequestSchema,
  SubmitConversationResponseSchema,
} from './chat-mode.js';
import { ConversationNavigationResponseSchema } from './dashboard.js';
import type { OperationDefinition } from './operation-contract.js';
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

/** Conversation discovery and submission preserve their existing bounded domain owners. */
export const CONVERSATION_OPERATION_DEFINITIONS = {
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
    binaryRequestBody: {
      mediaType: CONVERSATION_FILE_MEDIA_TYPE,
      description:
        'Four-byte unsigned big-endian UTF-8 JSON length (1 through 1,048,576), that many strict conversation.submit input bytes, then one exact payload per ordered fileInputs entry. No extra bytes. Combined payload limit: 1,000,000,000 bytes. JSON-only nonempty inventory reconciles an existing receipt; a new command returns file_input_bytes_required before effects.',
    },
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
