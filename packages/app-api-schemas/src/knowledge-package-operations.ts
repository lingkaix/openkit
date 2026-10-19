import { KnowledgeBaseIdSchema, RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';

/** Publication identity returned after native package validation and target Notebook publication. */
export const KnowledgePackageImportResponseSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  knowledgeBaseId: KnowledgeBaseIdSchema,
  notebookRevision: z.string().min(1),
});

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** Packages carry exact original streams; neither operation accepts file content in JSON or model input. */
export const KNOWLEDGE_PACKAGE_OPERATION_DEFINITIONS = {
  'knowledge.package.export': {
    binding: 'streaming',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Export the currently authorized Workspace Knowledge Base as a streamed package.',
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: z.unknown(),
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.package.import': {
    binding: 'streaming',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Import verified package bytes into a bootstrap-only Workspace Knowledge Base.',
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema, requestId: RequestIdSchema }).strict(),
    outputSchema: KnowledgePackageImportResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'knowledge.write',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
