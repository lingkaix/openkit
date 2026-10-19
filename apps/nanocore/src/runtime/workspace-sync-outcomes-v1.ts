import { TimestampSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

// SQL owns each outer format marker. These payload decoders normalize descriptive additions;
// native reads leave retained bytes unchanged and keep current command admission separate.
const StoredWorkspaceOutcomePathV1Schema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)/.test(value) &&
      !/(^|\/)\.\.(\/|$)/.test(value) &&
      !value.includes('\0'),
    { message: 'path must be relative to the workspace and must not escape it' }
  );

/** Fixed v1 apply observations ignore explanatory additions without changing their core outcome. */
const StoredWorkspaceVerificationV1Schema = z
  .object({
    command: z.string().min(1),
    status: z.enum(['passed', 'failed', 'skipped']),
    ref: z.string().min(1).nullable(),
  })
  .strip();

/** Frozen apply outcome; normalized reads and exports do not copy retained verification annotations. */
export const StoredWorkspaceApplyResultV1Schema = z
  .object({
    id: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    reviewId: z.string().min(1),
    changeSetId: z.string().min(1),
    status: z.enum(['applied', 'conflicted', 'blocked']),
    appliedPaths: z.array(StoredWorkspaceOutcomePathV1Schema),
    skippedPaths: z.array(StoredWorkspaceOutcomePathV1Schema),
    conflictRecords: z.array(z.string().min(1)),
    verification: z.array(StoredWorkspaceVerificationV1Schema),
    commitIds: z.array(z.string().min(1)),
    appliedAt: TimestampSchema,
  })
  .strip();

/** Frozen recovery observation; native updates preserve owned root and reachability annotations. */
export const StoredWorkspaceReconciliationRecordV1Schema = z
  .object({
    id: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    triggerReason: z.enum(['restart', 'backend_takeover', 'manual']),
    affectedRecordIds: z.array(z.string().min(1)),
    backendHandleSummary: z.record(z.string(), z.unknown()),
    backendReachability: z
      .object({
        status: z.enum(['reachable', 'unavailable', 'unknown']),
        checkedAt: TimestampSchema,
        detail: z.string().min(1).nullable(),
      })
      .strip(),
    collectedOutputManifestIds: z.array(z.string().min(1)),
    evidenceBundleIds: z.array(z.string().min(1)),
    stateBefore: z.string().min(1),
    stateAfter: z.enum(['recovered', 'requires-human', 'unrecoverable', 'quarantined']),
    quarantineRefs: z.array(StoredWorkspaceOutcomePathV1Schema),
    requiredHumanDecision: z.string().min(1).nullable(),
    retentionDecision: z.enum(['retain-backend', 'teardown-backend', 'not-applicable']),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
  })
  .strip();

/** Retained Quarantine ignores descriptive additions while current command admission remains strict. */
export const StoredWorkspaceQuarantineRecordV1Schema = z
  .object({
    id: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    lifecycleRecordIds: z.array(z.string().min(1)),
    failureKind: z.enum([
      'digest_mismatch',
      'lineage_mismatch',
      'path_violation',
      'schema_failure',
    ]),
    storageRef: StoredWorkspaceOutcomePathV1Schema,
    retentionClass: z.enum(['restricted-evidence', 'workspace-audit', 'legal-hold']),
    requiredHumanDecision: z.string().min(1).nullable(),
    resolution: z.enum(['pending', 'released_to_review', 'discarded', 'retained']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    resolvedAt: TimestampSchema.nullable(),
  })
  .strip();
