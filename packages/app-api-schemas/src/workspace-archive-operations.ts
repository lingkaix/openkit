import { RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';
import { WorkspaceImportDryRunResponseSchema, WorkspaceImportResponseSchema } from './storage.js';

/** Archive bytes belong only to the retained streaming bindings, never to a JSON operation input or result. */
export const WORKSPACE_ARCHIVE_OPERATION_DEFINITIONS = {
  'workspace.archive-download': {
    binding: 'streaming',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Download one verified portable Workspace archive.',
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema, exportId: z.string().min(1) }).strict(),
    outputSchema: z.unknown(),
    credentials: ['local-user', 'user-session', 'user-bearer', 'deployment-administrator'],
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.export',
    mutating: false,
  },
  'workspace.archive-import-dry-run': {
    binding: 'streaming',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Verify one streamed portable Workspace archive without importing it.',
    inputSchema: z.object({}).strict(),
    outputSchema: WorkspaceImportDryRunResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'user' },
    target: { kind: 'user' },
    policyOperation: 'workspace.write',
    mutating: false,
  },
  'workspace.archive-import': {
    binding: 'streaming',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Import one streamed portable Workspace archive.',
    inputSchema: z.object({ requestId: RequestIdSchema }).strict(),
    outputSchema: WorkspaceImportResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'user' },
    target: { kind: 'user' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
