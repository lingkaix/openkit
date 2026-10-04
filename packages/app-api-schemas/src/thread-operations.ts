import {
  ArchiveThreadRequestSchema,
  CreateThreadRequestSchema,
  ListThreadsResponseSchema,
  ThreadIdSchema,
  ThreadSchema,
  UpdateThreadRequestSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { ListThreadItemsResponseSchema, ThreadDashboardResponseSchema } from './dashboard.js';
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

/** Thread commands and audience-scoped reads retain the protocol, closeout and dashboard owners. */
export const THREAD_OPERATION_DEFINITIONS = {
  'thread.list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List visible Threads in one Workspace.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: ListThreadsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.update': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Update one visible Thread with exact command replay.',
    inputSchema: UpdateThreadRequestSchema,
    outputSchema: ThreadSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'thread.archive': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Archive one visible Thread and close out its pending requests.',
    inputSchema: ArchiveThreadRequestSchema,
    outputSchema: ThreadSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'thread.create': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description:
      'Create one Thread; private by default, explicitly workspace-shared for formal work.',
    inputSchema: CreateThreadRequestSchema.strict(),
    outputSchema: ThreadSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'thread.read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one visible Thread.',
    inputSchema: z.object(threadSelector).strict(),
    outputSchema: ThreadSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.items': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List durable Items for one visible Thread.',
    inputSchema: z
      .object({
        ...threadSelector,
        since: z.number().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    outputSchema: ListThreadItemsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.dashboard': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one visible Thread dashboard.',
    inputSchema: z.object(threadSelector).strict(),
    outputSchema: ThreadDashboardResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
