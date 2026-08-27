import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Redacted workspace vault use record exposed through the App API. */
export const WorkspaceVaultUseRecordSchema = z
  .object({
    useId: z.string().min(1),
    ownerScope: z.literal('workspace'),
    workspaceId: z.string().min(1),
    vaultReferenceId: z.string().min(1),
    materialVersion: z.number().int().positive().nullable(),
    backendKind: z.enum(['encrypted-file']),
    resolvingPath: z.enum(['grant', 'plan', 'admin', 'provider']),
    grantId: z.string().min(1).nullable(),
    planId: z.string().min(1).nullable(),
    receiptId: z.string().min(1).nullable(),
    agentSessionId: z.string().min(1).nullable(),
    capabilityCallId: z.string().min(1).nullable(),
    outcome: z.enum(['succeeded', 'failed', 'denied']),
    failureCode: z.string().min(1).nullable(),
    auditEventId: z.string().min(1).nullable(),
    usedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted server vault use record exposed through the App API. */
export const ServerVaultUseRecordSchema = z
  .object({
    useId: z.string().min(1),
    ownerScope: z.literal('server'),
    workspaceId: z.null(),
    vaultReferenceId: z.string().min(1),
    materialVersion: z.number().int().positive().nullable(),
    backendKind: z.enum(['encrypted-file']),
    resolvingPath: z.enum(['grant', 'plan', 'admin', 'provider']),
    grantId: z.string().min(1).nullable(),
    planId: z.string().min(1).nullable(),
    receiptId: z.string().min(1).nullable(),
    agentSessionId: z.string().min(1).nullable(),
    capabilityCallId: z.string().min(1).nullable(),
    outcome: z.enum(['succeeded', 'failed', 'denied']),
    failureCode: z.string().min(1).nullable(),
    auditEventId: z.string().min(1).nullable(),
    usedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted workspace vault use record list response. */
export const ListWorkspaceVaultUseRecordsResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    vaultUseRecords: z.array(WorkspaceVaultUseRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted server vault use record list response. */
export const ListServerVaultUseRecordsResponseSchema = z
  .object({
    vaultUseRecords: z.array(ServerVaultUseRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted workspace vault use record. */
export type WorkspaceVaultUseRecord = z.infer<typeof WorkspaceVaultUseRecordSchema>;
/** Redacted server vault use record. */
export type ServerVaultUseRecord = z.infer<typeof ServerVaultUseRecordSchema>;
/** Redacted workspace vault use record list response. */
export type ListWorkspaceVaultUseRecordsResponse = z.infer<
  typeof ListWorkspaceVaultUseRecordsResponseSchema
>;
/** Redacted server vault use record list response. */
export type ListServerVaultUseRecordsResponse = z.infer<
  typeof ListServerVaultUseRecordsResponseSchema
>;
