import { z } from 'zod';

/** Product-safe reference to evidence material included in an evidence bundle. */
export const EvidenceBundleRefSchema = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();

/** Durable workspace evidence bundle read model. */
export const EvidenceBundleRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    goalId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    agentSessionId: z.string().min(1).nullable(),
    backendType: z.string().min(1).nullable(),
    sourceKind: z.string().min(1),
    summary: z.string().min(1),
    rawEvidenceRefs: z.array(EvidenceBundleRefSchema),
    redactedEvidenceRefs: z.array(EvidenceBundleRefSchema),
    contentDigests: z.array(z.string().min(1)),
    retentionClass: z.enum([
      'ephemeral-diagnostic',
      'turn-evidence',
      'workspace-audit',
      'restricted-raw',
      'legal-hold',
    ]),
    sensitivityClass: z.enum(['product-safe', 'restricted', 'secret']),
    importStatus: z.enum([
      'collected',
      'verified',
      'normalized',
      'promoted',
      'quarantined',
      'expired',
    ]),
    requiredFeatures: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
  })
  .strict();

/** Read-only workspace evidence bundle list response. */
export const ListWorkspaceEvidenceBundlesResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    evidenceBundles: z.array(EvidenceBundleRecordSchema),
  })
  .strict();

/** Product-safe reference to evidence material included in an evidence bundle. */
export type EvidenceBundleRef = z.infer<typeof EvidenceBundleRefSchema>;

/** Durable workspace evidence bundle read model. */
export type EvidenceBundleRecord = z.infer<typeof EvidenceBundleRecordSchema>;

/** Read-only workspace evidence bundle list response. */
export type ListWorkspaceEvidenceBundlesResponse = z.infer<
  typeof ListWorkspaceEvidenceBundlesResponseSchema
>;
