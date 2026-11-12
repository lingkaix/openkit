import {
  CapabilityCallIdSchema,
  ItemIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
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

/** Narrowing selectors over exact retained lineage; identifiers grant no source admission. */
export const TimelineEvidenceFilterSchema = z
  .object({
    turnId: TurnIdSchema.optional(),
    capabilityCallId: CapabilityCallIdSchema.optional(),
    itemId: ItemIdSchema.optional(),
  })
  .strict();

/** Complete logical inputs and retained redacted outputs for the governance reads. */
export const GOVERNANCE_OPERATION_DEFINITIONS = {
  'usage.read': {
    stability: 'release-coupled',
    description:
      'Read capability-call and usage evidence for one workspace, optionally narrowed by exact run, call or Item.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z
      .object({
        workspaceId: WorkspaceIdSchema,
        limit: z.number().int().positive().optional(),
        cursor: z.string().min(1).optional(),
        ...TimelineEvidenceFilterSchema.shape,
      })
      .strict(),
    outputSchema: CapabilityUsageResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'audit.workspace-list': {
    stability: 'release-coupled',
    description: 'List audit events for one workspace in descending position order.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z
      .object({
        workspaceId: WorkspaceIdSchema,
        limit: z.number().int().positive().optional(),
        cursor: z.string().min(1).optional(),
        ...TimelineEvidenceFilterSchema.shape,
      })
      .strict(),
    outputSchema: ListWorkspaceAuditEventsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'audit.server-list': {
    stability: 'release-coupled',
    description: 'List server audit events.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z
      .object({
        limit: z.number().int().positive().optional(),
        cursor: z.string().min(1).optional(),
        ...TimelineEvidenceFilterSchema.shape,
      })
      .strict(),
    outputSchema: ListServerAuditEventsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'api.call',
    mutating: false,
  },
  'evidence.bundle-list': {
    stability: 'release-coupled',
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
    stability: 'release-coupled',
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
    stability: 'release-coupled',
    description: 'List permission decisions for one workspace.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z
      .object({
        workspaceId: WorkspaceIdSchema,
        limit: z.number().int().positive().optional(),
        cursor: z.string().min(1).optional(),
      })
      .strict(),
    outputSchema: ListWorkspacePermissionDecisionsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'permission.server-list': {
    stability: 'release-coupled',
    description: 'List server permission decisions.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z
      .object({
        limit: z.number().int().positive().optional(),
        cursor: z.string().min(1).optional(),
      })
      .strict(),
    outputSchema: ListServerPermissionDecisionsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'api.call',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
