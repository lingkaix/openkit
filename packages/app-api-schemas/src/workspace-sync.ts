import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';

const unsafeRelativePathPattern = /(^|\/)\.\.(\/|$)/;
const absolutePathPattern = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)/;

/**
 * Checks whether a workspace path is a safe repository-relative path.
 *
 * @param value Candidate path.
 * @returns True when the path is relative and cannot escape the workspace root.
 */
function isSafeWorkspaceRelativePath(value: string): boolean {
  return (
    !absolutePathPattern.test(value) &&
    !unsafeRelativePathPattern.test(value) &&
    !value.includes('\0')
  );
}

/** Product-safe workspace-relative path. */
export const WorkspaceRelativePathSchema = z.string().min(1).refine(isSafeWorkspaceRelativePath, {
  message: 'path must be relative to the workspace and must not escape it',
});

/** Workspace synchronization strategy selected by NanoCore. */
export const WorkspaceSynchronizationStrategySchema = z.enum(['git', 'filesystem']);

/** Worker backend kind recorded on workspace synchronization records. */
export const WorkspaceSynchronizationBackendKindSchema = z.enum([
  'host',
  'openshell',
  'docker',
  'remote-vm',
  'managed-sandbox',
]);

/** Workspace resource kind used by workspace synchronization records. */
export const WorkspaceSynchronizationResourceKindSchema = z.enum(['git_repository', 'filesystem']);

/** Base or head version marker for a materialized workspace. */
export const WorkspaceVersionRefSchema = z
  .object({
    commit: z.string().min(1).nullable(),
    contentDigest: z.string().min(1).nullable(),
  })
  .strict();

/** Redacted backend summary associated with a workspace input snapshot. */
export const WorkspaceSynchronizationBackendSummarySchema = z
  .object({
    kind: WorkspaceSynchronizationBackendKindSchema,
    label: z.string().min(1),
    capabilitySummary: z.array(z.string().min(1)),
  })
  .strict();

/** Generated file included in a workspace input snapshot. */
export const WorkspaceInputGeneratedFileSchema = z
  .object({
    id: z.string().min(1),
    target: WorkspaceRelativePathSchema,
  })
  .strict();

/** NanoCore-owned record describing the workspace state intended for a worker. */
export const WorkspaceInputSnapshotSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    resourceId: z.string().min(1),
    sourceId: z.string().min(1).optional(),
    resourceKind: WorkspaceSynchronizationResourceKindSchema,
    strategy: WorkspaceSynchronizationStrategySchema,
    pathScope: z.array(WorkspaceRelativePathSchema),
    writableRoots: z.array(WorkspaceRelativePathSchema),
    ignoredPaths: z.array(WorkspaceRelativePathSchema),
    generatedFiles: z.array(WorkspaceInputGeneratedFileSchema),
    base: WorkspaceVersionRefSchema,
    backend: WorkspaceSynchronizationBackendSummarySchema,
    createdAt: TimestampSchema,
  })
  .strict();

/** Product-safe readiness evidence reference for a materialized workspace. */
export const WorkspaceEvidenceRefSchema = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();

/** NanoCore-owned record describing a backend materialization effect. */
export const WorkspaceMaterializationRecordSchema = z
  .object({
    id: z.string().min(1),
    inputSnapshotId: z.string().min(1),
    workspaceId: z.string().min(1),
    sourceId: z.string().min(1).optional(),
    backendKind: WorkspaceSynchronizationBackendKindSchema,
    packageSnapshotId: z.string().min(1),
    workerSessionId: z.string().min(1),
    strategy: WorkspaceSynchronizationStrategySchema,
    materializedRootRef: z.string().min(1),
    base: WorkspaceVersionRefSchema,
    policyDigest: z.string().min(1),
    readinessEvidence: z.array(WorkspaceEvidenceRefSchema),
    createdAt: TimestampSchema,
  })
  .strict();

/** Redacted backend transport reference retained for recovery. */
export const BackendWorkspaceTransportRefSchema = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();

/** NanoCore-owned backend workspace handle needed for restart recovery. */
export const BackendWorkspaceHandleSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    materializationRecordId: z.string().min(1),
    backendKind: WorkspaceSynchronizationBackendKindSchema,
    packageSnapshotId: z.string().min(1),
    workerSessionId: z.string().min(1),
    transportRefs: z.array(BackendWorkspaceTransportRefSchema),
    cleanupStatus: z.enum(['pending', 'retained', 'cleaned', 'failed']),
    retention: z.enum(['until-reconciliation', 'retain-for-debug', 'cleanup-requested']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

/** Product-safe output reference declared by a worker output manifest. */
export const WorkerOutputRefSchema = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1),
    digest: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

/** Worker-declared output ignored by NanoCore collection policy. */
export const WorkerIgnoredOutputSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    reason: z.string().min(1),
  })
  .strict();

/** Status for one changed workspace path. */
export const WorkspaceChangedPathStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'mode_changed',
]);

/** Product-safe binary review presentation for one changed workspace path. */
export const WorkspaceBinaryReviewPresentationSchema = z
  .object({
    mode: z.literal('artifact-only'),
    reason: z.enum(['binary-path', 'binary-payload-too-large']),
    summary: z.string().min(1),
    digest: z.string().min(1).nullable(),
    mediaType: z.string().min(1).nullable(),
    bytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** One path changed by a worker. */
export const WorkspaceChangedPathSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    oldPath: WorkspaceRelativePathSchema.optional(),
    status: WorkspaceChangedPathStatusSchema,
    binary: z.boolean().default(false),
    size: z.number().int().nonnegative().optional(),
    digest: z.string().min(1).optional(),
    mediaType: z.string().min(1).optional(),
    binaryReview: WorkspaceBinaryReviewPresentationSchema.optional(),
    oldPermissions: z
      .string()
      .regex(/^0[0-7]{3}$/)
      .optional(),
    newPermissions: z
      .string()
      .regex(/^0[0-7]{3}$/)
      .optional(),
  })
  .strict();

/** NanoCore-owned record of the worker's declared workspace outputs before verification. */
export const WorkerOutputManifestSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    materializationRecordId: z.string().min(1),
    inputSnapshotId: z.string().min(1),
    workerSessionId: z.string().min(1),
    backendKind: WorkspaceSynchronizationBackendKindSchema,
    strategy: WorkspaceSynchronizationStrategySchema,
    changedPaths: z.array(WorkspaceChangedPathSchema),
    artifactIds: z.array(z.string().min(1)),
    logRefs: z.array(WorkerOutputRefSchema),
    testOutputRefs: z.array(WorkerOutputRefSchema),
    ignoredOutputs: z.array(WorkerIgnoredOutputSchema),
    evidenceRefs: z.array(WorkspaceEvidenceRefSchema),
    collectedAt: TimestampSchema,
  })
  .strict();

/** File-like payload reference produced by a backend transport. */
export const WorkspacePayloadRefSchema = z
  .object({
    ref: z.string().min(1),
    digest: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

/** Redaction state for a workspace change set. */
export const WorkspaceChangeSetRedactionSchema = z
  .object({
    status: z.enum(['redacted', 'no-sensitive-content-found']),
    notes: z.array(z.string().min(1)),
  })
  .strict();

/** NanoCore-owned record describing worker-produced workspace changes. */
export const WorkspaceChangeSetSchema = z
  .object({
    id: z.string().min(1),
    materializationRecordId: z.string().min(1),
    inputSnapshotId: z.string().min(1),
    workspaceId: z.string().min(1),
    resourceId: z.string().min(1),
    sourceId: z.string().min(1).optional(),
    strategy: WorkspaceSynchronizationStrategySchema,
    base: WorkspaceVersionRefSchema,
    head: WorkspaceVersionRefSchema,
    changedPaths: z.array(WorkspaceChangedPathSchema),
    patch: WorkspacePayloadRefSchema.nullable(),
    bundle: WorkspacePayloadRefSchema.nullable(),
    artifactIds: z.array(z.string().min(1)),
    evidenceRefs: z.array(WorkspaceEvidenceRefSchema),
    redaction: WorkspaceChangeSetRedactionSchema,
    createdAt: TimestampSchema,
  })
  .strict();

/** Staging strategy used for human review. */
export const StagedWorkspaceReviewStrategySchema = z.enum(['git_worktree', 'filesystem_staging']);

/** Current review status for a staged workspace change set. */
export const StagedWorkspaceReviewStatusSchema = z.enum([
  'pending',
  'accepted',
  'needs_refinement',
  'rejected',
  'blocked',
]);

/** Durable workspace review decisions accepted by the app-local Action Center workflow. */
export const WorkspaceSyncReviewDecisionSchema = z.enum([
  'accepted',
  'needs_refinement',
  'rejected',
  'blocked',
]);

/** Product-safe reference to staged workspace changes. */
export const StagedWorkspaceReviewStagingRefSchema = z
  .object({
    strategy: StagedWorkspaceReviewStrategySchema,
    ref: z.string().min(1),
    branch: z.string().min(1).nullable().optional(),
  })
  .strict();

/** Summary of a staged diff. */
export const StagedWorkspaceReviewDiffSummarySchema = z
  .object({
    filesChanged: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

/** Validation result associated with a staged workspace review. */
export const StagedWorkspaceReviewValidationSchema = z
  .object({
    command: z.string().min(1),
    status: z.enum(['passed', 'failed', 'skipped']),
    ref: z.string().min(1).nullable(),
  })
  .strict();

/** NanoCore-owned review record for staged workspace changes. */
export const StagedWorkspaceReviewSchema = z
  .object({
    id: z.string().min(1),
    changeSetId: z.string().min(1),
    workspaceId: z.string().min(1),
    status: StagedWorkspaceReviewStatusSchema,
    staging: StagedWorkspaceReviewStagingRefSchema,
    diffSummary: StagedWorkspaceReviewDiffSummarySchema,
    riskSummary: z.string().min(1),
    validation: z.array(StagedWorkspaceReviewValidationSchema),
    actionCenterRowId: z.string().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

/** Product-safe patch payload collected for a workspace synchronization review. */
export const WorkspaceSyncReviewPatchPayloadSchema = z
  .object({
    mediaType: z.literal('text/x-diff'),
    text: z.string(),
    encoding: z.literal('base64').optional(),
    digest: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .superRefine((value, ctx) => {
    if (value.encoding === 'base64') {
      try {
        if (btoa(atob(value.text)) !== value.text) throw new Error('Noncanonical base64.');
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Patch bytes require canonical base64.',
          path: ['text'],
        });
        return;
      }
    }
  });

/** Returns exact patch bytes; absent encoding denotes the existing UTF-8 text representation. */
export function workspaceSyncReviewPatchBytes(payload: {
  text: string;
  encoding?: 'base64' | undefined;
}): Uint8Array {
  return payload.encoding === 'base64'
    ? Uint8Array.from(atob(payload.text), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(payload.text);
}

/** Planned workspace writes and checks captured before applying an accepted review. */
export const WorkspaceApplyPlanSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    changeSetId: z.string().min(1),
    strategy: WorkspaceSynchronizationStrategySchema,
    approvalState: z.enum(['approved', 'blocked']),
    plannedWrites: z.array(WorkspaceRelativePathSchema),
    baselineChecks: z.array(StagedWorkspaceReviewValidationSchema),
    pathConflicts: z.array(z.string().min(1)),
    binaryRisks: z.array(WorkspaceRelativePathSchema),
    permissionChanges: z.array(WorkspaceRelativePathSchema),
    policyChecks: z.array(StagedWorkspaceReviewValidationSchema),
    createdAt: TimestampSchema,
  })
  .strict();

/** Result of applying a human-accepted workspace synchronization review. */
export const WorkspaceApplyResultSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    changeSetId: z.string().min(1),
    status: z.enum(['applied', 'conflicted', 'blocked']),
    appliedPaths: z.array(WorkspaceRelativePathSchema),
    skippedPaths: z.array(WorkspaceRelativePathSchema),
    conflictRecords: z.array(z.string().min(1)),
    verification: z.array(StagedWorkspaceReviewValidationSchema),
    commitIds: z.array(z.string().min(1)),
    appliedAt: TimestampSchema,
  })
  .strict();

/** Durable restart recovery state for workspace synchronization. */
export const WorkspaceReconciliationRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    triggerReason: z.enum(['restart', 'backend_takeover', 'manual']),
    affectedRecordIds: z.array(z.string().min(1)),
    backendHandleSummary: z.record(z.string(), z.unknown()),
    backendReachability: z
      .object({
        status: z.enum(['reachable', 'unavailable', 'unknown']),
        checkedAt: TimestampSchema,
        detail: z.string().min(1).nullable(),
      })
      .strict(),
    collectedOutputManifestIds: z.array(z.string().min(1)),
    evidenceBundleIds: z.array(z.string().min(1)),
    stateBefore: z.string().min(1),
    stateAfter: z.enum(['recovered', 'requires-human', 'unrecoverable', 'quarantined']),
    quarantineRefs: z.array(WorkspaceRelativePathSchema),
    requiredHumanDecision: z.string().min(1).nullable(),
    retentionDecision: z.enum(['retain-backend', 'teardown-backend', 'not-applicable']),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
  })
  .strict();

/** Human recovery decisions accepted for a requires-human reconciliation record. */
export const WorkspaceRecoveryDecisionSchema = z.enum([
  'resume_collection',
  'stage_verified',
  'quarantine',
  'abandon',
]);

/** Durable quarantine record isolating invalid workspace synchronization material. */
export const WorkspaceQuarantineRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    lifecycleRecordIds: z.array(z.string().min(1)),
    failureKind: z.enum([
      'digest_mismatch',
      'lineage_mismatch',
      'path_violation',
      'schema_failure',
    ]),
    storageRef: WorkspaceRelativePathSchema,
    retentionClass: z.enum(['restricted-evidence', 'workspace-audit', 'legal-hold']),
    requiredHumanDecision: z.string().min(1).nullable(),
    resolution: z.enum(['pending', 'released_to_review', 'discarded', 'retained']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    resolvedAt: TimestampSchema.nullable(),
  })
  .strict();

/** Public App API item joining one workspace review with its change set and backing artifact. */
export const WorkspaceSyncReviewItemSchema = z
  .object({
    artifactId: z.string().min(1),
    changeSet: WorkspaceChangeSetSchema,
    patchPayload: WorkspaceSyncReviewPatchPayloadSchema.nullable(),
    review: StagedWorkspaceReviewSchema,
  })
  .strict();

/** App API response listing workspace synchronization reviews for one workspace. */
export const ListWorkspaceSyncReviewsResponseSchema = z
  .object({
    items: z.array(WorkspaceSyncReviewItemSchema),
  })
  .strict();

/** App API response reading one workspace synchronization review by id. */
export const GetWorkspaceSyncReviewResponseSchema = WorkspaceSyncReviewItemSchema;

/** Request payload for recording one durable workspace synchronization review decision. */
export const SubmitWorkspaceSyncReviewDecisionRequestSchema = z
  .object({
    decision: WorkspaceSyncReviewDecisionSchema,
    requestId: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

/** Response payload after recording one durable workspace synchronization review decision. */
export const SubmitWorkspaceSyncReviewDecisionResponseSchema = z
  .object({
    review: StagedWorkspaceReviewSchema,
    workspaceApplyResult: WorkspaceApplyResultSchema.nullable().optional(),
  })
  .strict();

/** Request payload for recording one workspace recovery decision. */
export const SubmitWorkspaceRecoveryDecisionRequestSchema = z
  .object({
    decision: WorkspaceRecoveryDecisionSchema,
    requestId: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

/** Response payload after recording one workspace recovery decision. */
export const SubmitWorkspaceRecoveryDecisionResponseSchema = z
  .object({
    reconciliationRecord: WorkspaceReconciliationRecordSchema,
  })
  .strict();

/** App API response listing durable workspace input snapshots for one workspace. */
export const ListWorkspaceInputSnapshotsResponseSchema = z
  .object({
    items: z.array(WorkspaceInputSnapshotSchema),
  })
  .strict();

/** App API response listing durable workspace materialization records for one workspace. */
export const ListWorkspaceMaterializationRecordsResponseSchema = z
  .object({
    items: z.array(WorkspaceMaterializationRecordSchema),
  })
  .strict();

/** App API response listing durable backend workspace handles for one workspace. */
export const ListBackendWorkspaceHandlesResponseSchema = z
  .object({
    items: z.array(BackendWorkspaceHandleSchema),
  })
  .strict();

/** App API response listing durable worker output manifests for one workspace. */
export const ListWorkerOutputManifestsResponseSchema = z
  .object({
    items: z.array(WorkerOutputManifestSchema),
  })
  .strict();

/** App API response listing durable workspace change sets for one workspace. */
export const ListWorkspaceChangeSetsResponseSchema = z
  .object({
    items: z.array(WorkspaceChangeSetSchema),
  })
  .strict();

/** App API response listing durable staged workspace reviews for one workspace. */
export const ListStagedWorkspaceReviewsResponseSchema = z
  .object({
    items: z.array(StagedWorkspaceReviewSchema),
  })
  .strict();

/** App API response listing durable workspace apply results for one workspace. */
export const ListWorkspaceApplyPlansResponseSchema = z
  .object({
    items: z.array(WorkspaceApplyPlanSchema),
  })
  .strict();

/** App API response listing durable workspace reconciliation records for one workspace. */
export const ListWorkspaceReconciliationRecordsResponseSchema = z
  .object({
    items: z.array(WorkspaceReconciliationRecordSchema),
  })
  .strict();

/** App API response listing durable workspace quarantine records for one workspace. */
export const ListWorkspaceQuarantineRecordsResponseSchema = z
  .object({
    items: z.array(WorkspaceQuarantineRecordSchema),
  })
  .strict();

/** App API response listing durable workspace apply results for one workspace. */
export const ListWorkspaceApplyResultsResponseSchema = z
  .object({
    items: z.array(WorkspaceApplyResultSchema),
  })
  .strict();

/** App API response reading one durable workspace apply result by id. */
export const GetWorkspaceApplyResultResponseSchema = WorkspaceApplyResultSchema;

// Retained observations normalize to the exact producer core; apply instructions keep their producer schemas.
const WorkspaceVersionRefReaderSchema = WorkspaceVersionRefSchema.strip();
const WorkspaceEvidenceRefReaderSchema = WorkspaceEvidenceRefSchema.strip();
const WorkspaceChangedPathReaderSchema = WorkspaceChangedPathSchema.safeExtend({
  binaryReview: WorkspaceBinaryReviewPresentationSchema.strip().optional(),
}).strip();

/** Consumed retained input snapshot; unknown descriptive fields never reach materialization. */
export const WorkspaceInputSnapshotReaderSchema = WorkspaceInputSnapshotSchema.safeExtend({
  base: WorkspaceVersionRefReaderSchema,
  backend: WorkspaceSynchronizationBackendSummarySchema.strip(),
  generatedFiles: z.array(WorkspaceInputGeneratedFileSchema.strip()),
}).strip();

/** Consumed retained materialization fact, with immutable package and backend lineage intact. */
export const WorkspaceMaterializationRecordReaderSchema =
  WorkspaceMaterializationRecordSchema.safeExtend({
    base: WorkspaceVersionRefReaderSchema,
    readinessEvidence: z.array(WorkspaceEvidenceRefReaderSchema),
  }).strip();

/** Consumed retained backend handle; this observation grants no attachment authority. */
export const BackendWorkspaceHandleReaderSchema = BackendWorkspaceHandleSchema.safeExtend({
  transportRefs: z.array(BackendWorkspaceTransportRefSchema.strip()),
}).strip();

/** Consumed retained output observations, excluding unrecognized descriptive content. */
export const WorkerOutputManifestReaderSchema = WorkerOutputManifestSchema.safeExtend({
  changedPaths: z.array(WorkspaceChangedPathReaderSchema),
  logRefs: z.array(WorkerOutputRefSchema.strip()),
  testOutputRefs: z.array(WorkerOutputRefSchema.strip()),
  ignoredOutputs: z.array(WorkerIgnoredOutputSchema.strip()),
  evidenceRefs: z.array(WorkspaceEvidenceRefReaderSchema),
}).strip();

/** Consumed retained change set; original patch bytes and their digests stay separate. */
export const WorkspaceChangeSetReaderSchema = WorkspaceChangeSetSchema.safeExtend({
  base: WorkspaceVersionRefReaderSchema,
  head: WorkspaceVersionRefReaderSchema,
  changedPaths: z.array(WorkspaceChangedPathReaderSchema),
  patch: WorkspacePayloadRefSchema.strip().nullable(),
  bundle: WorkspacePayloadRefSchema.strip().nullable(),
  evidenceRefs: z.array(WorkspaceEvidenceRefReaderSchema),
  redaction: WorkspaceChangeSetRedactionSchema.strip(),
}).strip();

/** Consumed retained review; exact review decisions remain separate instructions. */
export const StagedWorkspaceReviewReaderSchema = StagedWorkspaceReviewSchema.safeExtend({
  staging: StagedWorkspaceReviewStagingRefSchema.strip(),
  diffSummary: StagedWorkspaceReviewDiffSummarySchema.strip(),
  validation: z.array(StagedWorkspaceReviewValidationSchema.strip()),
}).strip();

/** Consumed retained apply result; verification observations normalize while conflict strings stay validated. */
export const WorkspaceApplyResultReaderSchema = WorkspaceApplyResultSchema.safeExtend({
  verification: z.array(StagedWorkspaceReviewValidationSchema.strip()),
}).strip();

/** Consumed retained reconciliation observations; recovery decisions keep their exact instruction schema. */
export const WorkspaceReconciliationRecordReaderSchema =
  WorkspaceReconciliationRecordSchema.safeExtend({
    backendReachability: WorkspaceReconciliationRecordSchema.shape.backendReachability.strip(),
  }).strip();

/** Product-safe workspace-relative path. */
export type WorkspaceRelativePath = z.infer<typeof WorkspaceRelativePathSchema>;
/** Workspace synchronization strategy selected by NanoCore. */
export type WorkspaceSynchronizationStrategy = z.infer<
  typeof WorkspaceSynchronizationStrategySchema
>;
/** Worker backend kind recorded on workspace synchronization records. */
export type WorkspaceSynchronizationBackendKind = z.infer<
  typeof WorkspaceSynchronizationBackendKindSchema
>;
/** Workspace resource kind used by workspace synchronization records. */
export type WorkspaceSynchronizationResourceKind = z.infer<
  typeof WorkspaceSynchronizationResourceKindSchema
>;
/** NanoCore-owned record describing the workspace state intended for a worker. */
export type WorkspaceInputSnapshot = z.infer<typeof WorkspaceInputSnapshotSchema>;
/** NanoCore-owned record describing a backend materialization effect. */
export type WorkspaceMaterializationRecord = z.infer<typeof WorkspaceMaterializationRecordSchema>;
/** NanoCore-owned backend workspace handle needed for restart recovery. */
export type BackendWorkspaceHandle = z.infer<typeof BackendWorkspaceHandleSchema>;
/** Product-safe output reference declared by a worker output manifest. */
export type WorkerOutputRef = z.infer<typeof WorkerOutputRefSchema>;
/** Worker-declared output ignored by NanoCore collection policy. */
export type WorkerIgnoredOutput = z.infer<typeof WorkerIgnoredOutputSchema>;
/** Product-safe binary review presentation for one changed workspace path. */
export type WorkspaceBinaryReviewPresentation = z.infer<
  typeof WorkspaceBinaryReviewPresentationSchema
>;
/** One path changed by a worker. */
export type WorkspaceChangedPath = z.infer<typeof WorkspaceChangedPathSchema>;
/** NanoCore-owned record of the worker's declared workspace outputs before verification. */
export type WorkerOutputManifest = z.infer<typeof WorkerOutputManifestSchema>;
/** NanoCore-owned record describing worker-produced workspace changes. */
export type WorkspaceChangeSet = z.infer<typeof WorkspaceChangeSetSchema>;
/** NanoCore-owned review record for staged workspace changes. */
export type StagedWorkspaceReview = z.infer<typeof StagedWorkspaceReviewSchema>;
/** Current review status for a staged workspace change set. */
export type StagedWorkspaceReviewStatus = z.infer<typeof StagedWorkspaceReviewStatusSchema>;
/** Durable workspace review decisions accepted by the app-local Action Center workflow. */
export type WorkspaceSyncReviewDecision = z.infer<typeof WorkspaceSyncReviewDecisionSchema>;
/** Human recovery decisions accepted for a requires-human reconciliation record. */
export type WorkspaceRecoveryDecision = z.infer<typeof WorkspaceRecoveryDecisionSchema>;
/** Product-safe patch payload collected for a workspace synchronization review. */
export type WorkspaceSyncReviewPatchPayload = z.infer<typeof WorkspaceSyncReviewPatchPayloadSchema>;
/** Planned workspace writes and checks captured before applying an accepted review. */
export type WorkspaceApplyPlan = z.infer<typeof WorkspaceApplyPlanSchema>;
/** Result of applying a human-accepted workspace synchronization review. */
export type WorkspaceApplyResult = z.infer<typeof WorkspaceApplyResultSchema>;
/** Durable restart recovery state for workspace synchronization. */
export type WorkspaceReconciliationRecord = z.infer<typeof WorkspaceReconciliationRecordSchema>;
/** Durable quarantine record isolating invalid workspace synchronization material. */
export type WorkspaceQuarantineRecord = z.infer<typeof WorkspaceQuarantineRecordSchema>;
/** Public item joining one workspace sync review with its parsed change set. */
export type WorkspaceSyncReviewItem = z.infer<typeof WorkspaceSyncReviewItemSchema>;
/** App API response listing workspace synchronization reviews for one workspace. */
export type ListWorkspaceSyncReviewsResponse = z.infer<
  typeof ListWorkspaceSyncReviewsResponseSchema
>;
/** App API response reading one workspace synchronization review by id. */
export type GetWorkspaceSyncReviewResponse = z.infer<typeof GetWorkspaceSyncReviewResponseSchema>;
/** Request payload for recording one durable workspace synchronization review decision. */
export type SubmitWorkspaceSyncReviewDecisionRequest = z.infer<
  typeof SubmitWorkspaceSyncReviewDecisionRequestSchema
>;
/** Response payload after recording one durable workspace synchronization review decision. */
export type SubmitWorkspaceSyncReviewDecisionResponse = z.infer<
  typeof SubmitWorkspaceSyncReviewDecisionResponseSchema
>;
/** Request payload for recording one workspace recovery decision. */
export type SubmitWorkspaceRecoveryDecisionRequest = z.infer<
  typeof SubmitWorkspaceRecoveryDecisionRequestSchema
>;
/** Response payload after recording one workspace recovery decision. */
export type SubmitWorkspaceRecoveryDecisionResponse = z.infer<
  typeof SubmitWorkspaceRecoveryDecisionResponseSchema
>;
/** App API response listing durable workspace input snapshots for one workspace. */
export type ListWorkspaceInputSnapshotsResponse = z.infer<
  typeof ListWorkspaceInputSnapshotsResponseSchema
>;
/** App API response listing durable workspace materialization records for one workspace. */
export type ListWorkspaceMaterializationRecordsResponse = z.infer<
  typeof ListWorkspaceMaterializationRecordsResponseSchema
>;
/** App API response listing durable backend workspace handles for one workspace. */
export type ListBackendWorkspaceHandlesResponse = z.infer<
  typeof ListBackendWorkspaceHandlesResponseSchema
>;
/** App API response listing durable worker output manifests for one workspace. */
export type ListWorkerOutputManifestsResponse = z.infer<
  typeof ListWorkerOutputManifestsResponseSchema
>;
/** App API response listing durable workspace change sets for one workspace. */
export type ListWorkspaceChangeSetsResponse = z.infer<typeof ListWorkspaceChangeSetsResponseSchema>;
/** App API response listing durable staged workspace reviews for one workspace. */
export type ListStagedWorkspaceReviewsResponse = z.infer<
  typeof ListStagedWorkspaceReviewsResponseSchema
>;
/** App API response listing durable workspace apply results for one workspace. */
export type ListWorkspaceApplyPlansResponse = z.infer<typeof ListWorkspaceApplyPlansResponseSchema>;
/** App API response listing durable workspace reconciliation records for one workspace. */
export type ListWorkspaceReconciliationRecordsResponse = z.infer<
  typeof ListWorkspaceReconciliationRecordsResponseSchema
>;
/** App API response listing durable workspace quarantine records for one workspace. */
export type ListWorkspaceQuarantineRecordsResponse = z.infer<
  typeof ListWorkspaceQuarantineRecordsResponseSchema
>;
/** App API response listing durable workspace apply results for one workspace. */
export type ListWorkspaceApplyResultsResponse = z.infer<
  typeof ListWorkspaceApplyResultsResponseSchema
>;
/** App API response reading one durable workspace apply result by id. */
export type GetWorkspaceApplyResultResponse = z.infer<typeof GetWorkspaceApplyResultResponseSchema>;
