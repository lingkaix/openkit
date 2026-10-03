import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunRequestSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportRequestSchema,
  WorkspaceImportResponseSchema,
} from './storage.js';

const canonicalUserCredentials = [
  'local-user',
  'user-session',
  'deployment-administrator',
] as const;

/** Server-managed JSON portability handles; binary archive bindings retain their own owner. */
export const WORKSPACE_TRANSFER_OPERATION_DEFINITIONS = {
  'workspace.export': {
    description: 'Create and verify one server-managed Workspace export.',
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: WorkspaceExportResponseSchema,
    credentials: [...canonicalUserCredentials, 'user-bearer'],
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.export',
    mutating: true,
  },
  'workspace.import-dry-run': {
    description: 'Verify a server-managed Workspace export without importing it.',
    inputSchema: WorkspaceImportDryRunRequestSchema,
    outputSchema: WorkspaceImportDryRunResponseSchema,
    credentials: canonicalUserCredentials,
    scope: { kind: 'user' },
    target: { kind: 'user' },
    policyOperation: 'workspace.write',
    mutating: false,
  },
  'workspace.import': {
    description: 'Import one verified server-managed Workspace export.',
    inputSchema: WorkspaceImportRequestSchema,
    outputSchema: WorkspaceImportResponseSchema,
    credentials: canonicalUserCredentials,
    scope: { kind: 'user' },
    target: { kind: 'user' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
} as const;
