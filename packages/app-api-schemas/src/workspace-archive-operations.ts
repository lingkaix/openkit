import { WorkspaceExportIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';

/** Archive bytes belong only to the retained streaming bindings, never to a JSON operation input or result. */
export const WORKSPACE_ARCHIVE_OPERATION_DEFINITIONS = {
  'workspace.archive-download': {
    binding: 'streaming',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Download one verified portable Workspace archive.',
    inputSchema: z
      .object({ workspaceId: WorkspaceIdSchema, exportId: WorkspaceExportIdSchema })
      .strict(),
    outputSchema: z.unknown(),
    credentials: ['local-user', 'user-session', 'user-bearer', 'deployment-administrator'],
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.export',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
