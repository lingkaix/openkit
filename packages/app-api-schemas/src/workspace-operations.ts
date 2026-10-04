import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceIdSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesResponseSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { WorkspaceDashboardResponseSchema } from './dashboard.js';
import type { OperationDefinition } from './operation-contract.js';
import { ListAuthorizedWorkspacesResponseSchema } from './workspace-sharing.js';

/** Credentials already used by the public Workspace, Thread and Turn families. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

const workspaceSelector = { workspaceId: WorkspaceIdSchema };

/** Workspace commands, viewer reads and candidate-first discovery retain their existing owners. */
export const WORKSPACE_OPERATION_DEFINITIONS = {
  'workspace.create': {
    binding: 'json',
    returnsOneTimeSecret: false,
    description: 'Create one actor-owned Workspace with exact command replay.',
    inputSchema: CreateWorkspaceRequestSchema.strict(),
    outputSchema: WorkspaceRecordSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'user' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
    successStatus: 201,
  },
  'workspace.read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one Workspace with viewer-visible counts.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: WorkspaceRecordSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'workspace.update': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Update one Workspace with exact command replay.',
    inputSchema: UpdateWorkspaceRequestSchema.extend(workspaceSelector).strict(),
    outputSchema: WorkspaceRecordSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.lifecycle',
    mutating: true,
  },
  'workspace.dashboard': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one Workspace dashboard with viewer-visible work and artifacts.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: WorkspaceDashboardResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'workspace.list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List authorized Workspaces with effective access and revisions.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListAuthorizedWorkspacesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'authorized-workspace-set' },
    target: { kind: 'authorized-workspaces' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'workspace.resources': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one Workspace resource bundle.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: WorkspaceResourcesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
