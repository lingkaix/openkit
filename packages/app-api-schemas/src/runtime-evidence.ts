import { z } from 'zod';

/** Product-safe file manifest summary attached to runtime evidence. */
export const RuntimeEvidenceManifestEntrySchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    digest: z.string().min(1),
  })
  .strict();

/** Durable workspace runtime evidence read model. */
export const RuntimeEvidenceRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    goalId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    agentSessionId: z.string().min(1).nullable(),
    backendType: z.string().min(1).nullable(),
    backendVersion: z.string().min(1).nullable(),
    placement: z.enum(['local', 'remote', 'unknown']),
    phase: z.enum([
      'sandbox-create',
      'capability-negotiation',
      'policy-apply',
      'provider-attach',
      'sidecar-startup',
      'heartbeat',
      'file-transfer',
      'transcript-collection',
      'workspace-change-collection',
      'teardown',
      'backend-error',
    ]),
    summary: z.string().min(1),
    policyDigest: z.string().min(1).nullable(),
    workerImage: z.string().min(1).nullable(),
    sandboxSummary: z.string().min(1).nullable(),
    capabilitySummary: z.string().min(1).nullable(),
    uploadManifest: z.array(RuntimeEvidenceManifestEntrySchema),
    downloadManifest: z.array(RuntimeEvidenceManifestEntrySchema),
    transcriptSummary: z.string().min(1).nullable(),
    workspaceChangeSummary: z.string().min(1).nullable(),
    controlSummary: z.string().min(1).nullable(),
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'unknown']),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).nullable(),
    stopReason: z.string().min(1).nullable(),
    errorCode: z.string().min(1).nullable(),
    errorMessage: z.string().min(1).nullable(),
    redactedStdoutSummary: z.string().min(1).nullable(),
    redactedStderrSummary: z.string().min(1).nullable(),
    evidenceBundleIds: z.array(z.string().min(1)),
    contentDigests: z.array(z.string().min(1)),
    requiredFeatures: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    collectedAt: z.string().datetime().nullable(),
  })
  .strict();

/** Read-only workspace runtime evidence list response. */
export const ListWorkspaceRuntimeEvidenceResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    runtimeEvidence: z.array(RuntimeEvidenceRecordSchema),
  })
  .strict();

/** Product-safe file manifest summary attached to runtime evidence. */
export type RuntimeEvidenceManifestEntry = z.infer<typeof RuntimeEvidenceManifestEntrySchema>;

/** Durable workspace runtime evidence read model. */
export type RuntimeEvidenceRecord = z.infer<typeof RuntimeEvidenceRecordSchema>;

/** Read-only workspace runtime evidence list response. */
export type ListWorkspaceRuntimeEvidenceResponse = z.infer<
  typeof ListWorkspaceRuntimeEvidenceResponseSchema
>;
