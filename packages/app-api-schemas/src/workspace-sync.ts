import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
    workerSessionId: z.string().min(1),
    strategy: WorkspaceSynchronizationStrategySchema,
    materializedRootRef: z.string().min(1),
    base: WorkspaceVersionRefSchema,
    policyDigest: z.string().min(1),
    readinessEvidence: z.array(WorkspaceEvidenceRefSchema),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
    workerSessionId: z.string().min(1),
    transportRefs: z.array(BackendWorkspaceTransportRefSchema),
    cleanupStatus: z.enum(['pending', 'retained', 'cleaned', 'failed']),
    retention: z.enum(['until-reconciliation', 'retain-for-debug', 'cleanup-requested']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** File-like payload reference produced by a backend transport. */
export const WorkspacePayloadRefSchema = z
  .object({
    ref: z.string().min(1),
    digest: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

/** Redacted workspace synchronization evidence manifest entry. */
export const WorkspaceSyncEvidenceManifestEntrySchema = z
  .object({
    kind: z.string().min(1),
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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Product-safe patch payload collected for a workspace synchronization review. */
export const WorkspaceSyncReviewPatchPayloadSchema = z
  .object({
    mediaType: z.literal('text/x-diff'),
    text: z.string(),
    digest: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Durable workspace synchronization evidence linkage record. */
export const WorkspaceSyncEvidenceBundleSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    lifecycleRecordIds: z.array(z.string().min(1)),
    evidenceBundleIds: z.array(z.string().min(1)),
    backendEvidenceRefs: z.array(WorkspaceEvidenceRefSchema),
    redactedEvidenceManifest: z.array(WorkspaceSyncEvidenceManifestEntrySchema),
    contentDigests: z.array(z.string().min(1)),
    retentionClass: z.enum(['turn-evidence', 'workspace-audit', 'restricted-raw', 'legal-hold']),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Public App API item joining one workspace review with its change set and backing artifact. */
export const WorkspaceSyncReviewItemSchema = z
  .object({
    artifactId: z.string().min(1),
    changeSet: WorkspaceChangeSetSchema,
    patchPayload: WorkspaceSyncReviewPatchPayloadSchema.nullable(),
    review: StagedWorkspaceReviewSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing workspace synchronization reviews for one workspace. */
export const ListWorkspaceSyncReviewsResponseSchema = z
  .object({
    items: z.array(WorkspaceSyncReviewItemSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

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
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable workspace input snapshots for one workspace. */
export const ListWorkspaceInputSnapshotsResponseSchema = z
  .object({
    items: z.array(WorkspaceInputSnapshotSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable workspace materialization records for one workspace. */
export const ListWorkspaceMaterializationRecordsResponseSchema = z
  .object({
    items: z.array(WorkspaceMaterializationRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable backend workspace handles for one workspace. */
export const ListBackendWorkspaceHandlesResponseSchema = z
  .object({
    items: z.array(BackendWorkspaceHandleSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable worker output manifests for one workspace. */
export const ListWorkerOutputManifestsResponseSchema = z
  .object({
    items: z.array(WorkerOutputManifestSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable workspace change sets for one workspace. */
export const ListWorkspaceChangeSetsResponseSchema = z
  .object({
    items: z.array(WorkspaceChangeSetSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable staged workspace reviews for one workspace. */
export const ListStagedWorkspaceReviewsResponseSchema = z
  .object({
    items: z.array(StagedWorkspaceReviewSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable workspace apply results for one workspace. */
export const ListWorkspaceApplyPlansResponseSchema = z
  .object({
    items: z.array(WorkspaceApplyPlanSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable workspace reconciliation records for one workspace. */
export const ListWorkspaceReconciliationRecordsResponseSchema = z
  .object({
    items: z.array(WorkspaceReconciliationRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable workspace quarantine records for one workspace. */
export const ListWorkspaceQuarantineRecordsResponseSchema = z
  .object({
    items: z.array(WorkspaceQuarantineRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable workspace synchronization evidence bundles. */
export const ListWorkspaceSyncEvidenceBundlesResponseSchema = z
  .object({
    items: z.array(WorkspaceSyncEvidenceBundleSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response listing durable workspace apply results for one workspace. */
export const ListWorkspaceApplyResultsResponseSchema = z
  .object({
    items: z.array(WorkspaceApplyResultSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** App API response reading one durable workspace apply result by id. */
export const GetWorkspaceApplyResultResponseSchema = WorkspaceApplyResultSchema;

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
/** Durable workspace synchronization evidence linkage record. */
export type WorkspaceSyncEvidenceBundle = z.infer<typeof WorkspaceSyncEvidenceBundleSchema>;
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
/** App API response listing durable workspace synchronization evidence bundles. */
export type ListWorkspaceSyncEvidenceBundlesResponse = z.infer<
  typeof ListWorkspaceSyncEvidenceBundlesResponseSchema
>;
/** App API response listing durable workspace apply results for one workspace. */
export type ListWorkspaceApplyResultsResponse = z.infer<
  typeof ListWorkspaceApplyResultsResponseSchema
>;
/** App API response reading one durable workspace apply result by id. */
export type GetWorkspaceApplyResultResponse = z.infer<typeof GetWorkspaceApplyResultResponseSchema>;
