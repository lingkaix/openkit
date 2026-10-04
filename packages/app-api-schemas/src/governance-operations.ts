import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  ListServerAuditEventsResponseSchema,
  ListServerPermissionDecisionsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
} from './audit.js';
import { CapabilityUsageResponseSchema } from './capability-usage.js';
import { ListWorkspaceEvidenceBundlesResponseSchema } from './evidence-bundles.js';
import type { OperationDefinition } from './operation-contract.js';
import { ListWorkspaceRuntimeEvidenceResponseSchema } from './runtime-evidence.js';

/** Existing public read credentials; server scope still requires current administrator authority. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** Complete logical inputs and retained redacted outputs for the governance reads. */
export const GOVERNANCE_OPERATION_DEFINITIONS = {
  'usage.read': {
    description: 'Read capability-call and usage evidence for one workspace.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: CapabilityUsageResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'audit.workspace-list': {
    description: 'List audit events for one workspace.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: ListWorkspaceAuditEventsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'audit.server-list': {
    description: 'List server audit events.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({}).strict(),
    outputSchema: ListServerAuditEventsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'api.call',
    mutating: false,
  },
  'evidence.bundle-list': {
    description: 'List evidence bundles for one workspace.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: ListWorkspaceEvidenceBundlesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'evidence.runtime-list': {
    description: 'List runtime evidence for one workspace.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: ListWorkspaceRuntimeEvidenceResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'permission.workspace-list': {
    description: 'List permission decisions for one workspace.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: ListWorkspacePermissionDecisionsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'permission.server-list': {
    description: 'List server permission decisions.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({}).strict(),
    outputSchema: ListServerPermissionDecisionsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'api.call',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
