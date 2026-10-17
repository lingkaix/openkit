import {
  WorkspacePolicyResourceSchema,
  WorkspaceResourceAccessEntrySchema,
} from '@openkit/config-schema/workspace-resource-policy';
import {
  ApprovalRequestIdSchema,
  ApprovalRequestSchema,
  RequestIdSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';
import { RuntimeConfigReloadResponseSchema } from './runtime-config.js';

/** Exact replacement, last-revoke empty boundary, or explicit removal captured for human review. */
export const WorkspaceResourcePolicyTermsSchema = z
  .object({
    resource: WorkspacePolicyResourceSchema,
    replacement: WorkspaceResourceAccessEntrySchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.replacement &&
      (value.resource.family !== value.replacement.resource.family ||
        value.resource.id !== value.replacement.resource.id)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['replacement', 'resource'],
        message: 'The replacement must identify the captured resource.',
      });
  });

/** The configuration revision is captured by the existing file owner when the request is raised. */
export const WorkspaceResourcePolicyChangeSchema = WorkspaceResourcePolicyTermsSchema.safeExtend({
  expectedRevision: z.string().min(1),
});

/** Request readback contains submitted terms and the existing Pending Request, never resolved target metadata. */
export const WorkspaceResourcePolicyRequestSchema = ApprovalRequestSchema.extend({
  change: WorkspaceResourcePolicyChangeSchema,
});

/** Workspace-scoped Policy administration; definitions remain inactive until the canonical table join. */
export const RESOURCE_POLICY_OPERATION_DEFINITIONS = {
  'workspace.resource-access-request': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Request a named Workspace Thread access change without changing its assignments.',
    inputSchema: z
      .object({
        workspaceId: WorkspaceIdSchema,
        threadId: ThreadIdSchema,
        requestId: RequestIdSchema,
        change: WorkspaceResourcePolicyTermsSchema,
      })
      .strict(),
    outputSchema: WorkspaceResourcePolicyRequestSchema,
    credentials: [
      'local-user',
      'user-session',
      'user-bearer',
      'deployment-administrator',
      'worker-package',
    ],
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'workspace.resource-access-apply': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description:
      'Apply an approved Workspace resource Policy change with distinct current human confirmation.',
    inputSchema: z
      .object({
        workspaceId: WorkspaceIdSchema,
        threadId: ThreadIdSchema,
        approvalRequestId: ApprovalRequestIdSchema,
        confirmation: z.literal('APPLY WORKSPACE RESOURCE POLICY'),
      })
      .strict(),
    outputSchema: z.object({
      approvalRequestId: ApprovalRequestIdSchema,
      workspaceId: WorkspaceIdSchema,
      threadId: ThreadIdSchema,
      savedRevision: z.string().nullable(),
      reloadStatus: RuntimeConfigReloadResponseSchema.shape.status,
    }),
    credentials: ['local-user', 'user-session', 'user-bearer', 'deployment-administrator'],
    scope: {
      kind: 'opaque-child-workspace',
      field: 'workspaceId',
      childField: 'approvalRequestId',
      childOwner: 'pending-request',
    },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.configure',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
