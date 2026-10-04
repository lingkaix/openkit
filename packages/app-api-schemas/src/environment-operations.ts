import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
} from './agent-environment.js';
import type { OperationDefinition } from './operation-contract.js';

/** Existing public read credentials; server scope still requires current administrator authority. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** Complete logical inputs and retained redacted outputs for the environment reads. */
export const ENVIRONMENT_OPERATION_DEFINITIONS = {
  'environment.snapshot-list': {
    description: 'List durable Agent Environment Package snapshots.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: ListAgentEnvironmentPackageSnapshotsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'environment.snapshot-read': {
    description: 'Read one Agent Environment Package snapshot.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z
      .object({ workspaceId: WorkspaceIdSchema, snapshotId: z.string().min(1) })
      .strict(),
    outputSchema: GetAgentEnvironmentPackageSnapshotResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
