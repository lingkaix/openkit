import { AuditEventSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Redacted workspace permission decision exposed through the App API. */
export const WorkspacePermissionDecisionSchema = z
  .object({
    decisionId: z.string().min(1),
    ownerScope: z.literal('workspace'),
    workspaceId: z.string().min(1),
    policyEngineVersion: z.string().min(1),
    policySnapshotId: z.string().min(1),
    subjectSummary: z.unknown(),
    action: z.string().min(1),
    resourceSummary: z.unknown(),
    contextSummary: z.unknown(),
    result: z.enum(['allow', 'deny', 'require_approval', 'not_applicable', 'error']),
    reasonCode: z.string().min(1),
    enforcementPoint: z.string().min(1),
    requiredApprovalKind: z.string().min(1).nullable(),
    approvalId: z.string().min(1).nullable(),
    auditEventId: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted server permission decision exposed through the App API. */
export const ServerPermissionDecisionSchema = z
  .object({
    decisionId: z.string().min(1),
    ownerScope: z.literal('server'),
    workspaceId: z.null(),
    policyEngineVersion: z.string().min(1),
    policySnapshotId: z.string().min(1),
    subjectSummary: z.unknown(),
    action: z.string().min(1),
    resourceSummary: z.unknown(),
    contextSummary: z.unknown(),
    result: z.enum(['allow', 'deny', 'require_approval', 'not_applicable', 'error']),
    reasonCode: z.string().min(1),
    enforcementPoint: z.string().min(1),
    requiredApprovalKind: z.string().min(1).nullable(),
    approvalId: z.string().min(1).nullable(),
    auditEventId: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Read-only workspace audit event ledger for one workspace. */
export const ListWorkspaceAuditEventsResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    auditEvents: z.array(AuditEventSchema),
  })
  .strict();

/** Read-only server audit event ledger. */
export const ListServerAuditEventsResponseSchema = z
  .object({
    auditEvents: z.array(AuditEventSchema),
  })
  .strict();

/** Read-only workspace audit event ledger for one workspace. */
export type ListWorkspaceAuditEventsResponse = z.infer<
  typeof ListWorkspaceAuditEventsResponseSchema
>;
/** Read-only server audit event ledger. */
export type ListServerAuditEventsResponse = z.infer<typeof ListServerAuditEventsResponseSchema>;

/** Read-only server permission decision ledger. */
export const ListServerPermissionDecisionsResponseSchema = z
  .object({
    permissionDecisions: z.array(ServerPermissionDecisionSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Read-only workspace permission decision ledger for one workspace. */
export const ListWorkspacePermissionDecisionsResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    permissionDecisions: z.array(WorkspacePermissionDecisionSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted workspace permission decision. */
export type WorkspacePermissionDecision = z.infer<typeof WorkspacePermissionDecisionSchema>;
/** Redacted server permission decision. */
export type ServerPermissionDecision = z.infer<typeof ServerPermissionDecisionSchema>;
/** Read-only server permission decision ledger. */
export type ListServerPermissionDecisionsResponse = z.infer<
  typeof ListServerPermissionDecisionsResponseSchema
>;
/** Read-only workspace permission decision ledger for one workspace. */
export type ListWorkspacePermissionDecisionsResponse = z.infer<
  typeof ListWorkspacePermissionDecisionsResponseSchema
>;
