import {
  AgentSessionIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Product-safe file manifest summary attached to runtime evidence. */
const StoredRuntimeEvidenceManifestV1Schema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    digest: z.string().min(1),
  })
  .strip();

/** Fixed retained v1 runtime evidence meaning; current wire objects admit new publications separately. */
export const StoredRuntimeEvidenceV1Schema = z
  .object({
    id: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema.nullable(),
    turnId: TurnIdSchema.nullable(),
    goalId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    agentSessionId: AgentSessionIdSchema.nullable(),
    backendType: z.string().min(1).nullable(),
    backendVersion: z.string().min(1).nullable(),
    placement: z.enum(['local', 'remote', 'unknown']),
    phase: z.enum([
      'sandbox-create',
      'capability-negotiation',
      'policy-apply',
      'provider-attach',
      'heartbeat',
      'file-transfer',
      'transcript-collection',
      'workspace-change-collection',
      'checkpoint',
      'teardown',
      'backend-error',
    ]),
    summary: z.string().min(1),
    policyDigest: z.string().min(1).nullable(),
    workerImage: z.string().min(1).nullable(),
    sandboxSummary: z.string().min(1).nullable(),
    capabilitySummary: z.string().min(1).nullable(),
    uploadManifest: z.array(StoredRuntimeEvidenceManifestV1Schema),
    downloadManifest: z.array(StoredRuntimeEvidenceManifestV1Schema),
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
  .strip();
