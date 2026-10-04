import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';
import { AppSearchResponseSchema } from './search.js';

/** Existing public read credentials; server scope still requires current administrator authority. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** Complete logical inputs and retained redacted outputs for the app-search reads. */
export const APP_SEARCH_OPERATION_DEFINITIONS = {
  'app.search': {
    description:
      'Search authorized Workspaces and visible Threads, Items, Knowledge and Artifacts.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({ query: z.string().default('') }).strict(),
    outputSchema: AppSearchResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'authorized-workspace-set' },
    target: { kind: 'authorized-workspaces' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
