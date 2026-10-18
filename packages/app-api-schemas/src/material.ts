import {
  ArtifactIdSchema,
  ArtifactInlineContentSchema,
  ArtifactMediaTypeSchema,
  ArtifactReviewIdSchema,
  ArtifactVersionRecordSchema,
  ArtifactVersionSchema,
  ItemIdSchema,
  MAX_ARTIFACT_FILE_BYTES,
  MaterialIdSchema,
  MaterialRevisionIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { ArtifactReviewDecisionSchema } from './action-center.js';
import { JudgementRecordReaderSchema } from './evaluation-readers.js';
import { ArtifactReviewRangeFeedbackSchema } from './material-range.js';

export { ArtifactReviewRangeFeedbackSchema } from './material-range.js';

/** Opaque non-empty identifier used by app-local Material contracts. */
const opaqueIdSchema = z.string().min(1);

/** Lowercase SHA-256 digest over exact canonical content bytes. */
const contentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Caller-supplied idempotency key excluding reserved import lineage. */
const requestIdSchema = opaqueIdSchema.refine((value) => !value.startsWith('import-lineage:'), {
  message: 'requestId uses a reserved import-lineage prefix',
});

/** Retained immutable Artifact history in increasing version order. */
export const ListArtifactVersionsResponseSchema = z.object({
  items: z.array(ArtifactVersionSchema),
});

/** Exact historical Artifact state and the immutable lineage of that version. */
export const ReadArtifactVersionResponseSchema = ArtifactVersionRecordSchema.safeExtend({
  version: ArtifactVersionSchema,
}).superRefine(({ artifact, version }, context) => {
  if (
    artifact.id !== version.artifactId ||
    artifact.workspaceId !== version.workspaceId ||
    artifact.version !== version.artifactVersion ||
    artifact.title !== version.title ||
    artifact.summary !== version.summary ||
    artifact.contentDigest !== version.contentDigest
  ) {
    context.addIssue({
      code: 'custom',
      path: ['version'],
      message: 'Artifact version summary must match its exact Artifact snapshot.',
    });
  }
});

/** One manual inline revision, communicated by a new Core-local Turn in the selected idle Thread. */
export const CommitArtifactVersionRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedArtifactVersion: z.number().int().positive(),
    title: z.string().min(1),
    summary: z.string().nullable(),
    content: ArtifactInlineContentSchema.strict(),
  })
  .strict();

/** Metadata for one streamed arbitrary-byte revision of the same Artifact. */
export const CommitArtifactFileVersionRequestSchema = CommitArtifactVersionRequestSchema.omit({
  content: true,
}).extend({
  mediaType: ArtifactMediaTypeSchema,
  byteLength: z.number().int().min(0).max(MAX_ARTIFACT_FILE_BYTES),
  contentDigest: contentDigestSchema,
});

/** Exact version result shared by inline and streamed publication. */
export const CommitArtifactVersionResponseSchema = ReadArtifactVersionResponseSchema;

/** Public retained-version inventory. */
export type ListArtifactVersionsResponse = z.infer<typeof ListArtifactVersionsResponseSchema>;
/** Public exact-version read result. */
export type ReadArtifactVersionResponse = z.infer<typeof ReadArtifactVersionResponseSchema>;
/** Public inline version command. */
export type CommitArtifactVersionRequest = z.infer<typeof CommitArtifactVersionRequestSchema>;
/** Public streamed version metadata. */
export type CommitArtifactFileVersionRequest = z.infer<
  typeof CommitArtifactFileVersionRequestSchema
>;
/** Public exact committed version result. */
export type CommitArtifactVersionResponse = z.infer<typeof CommitArtifactVersionResponseSchema>;

/** Material kinds supported by the app-local Workspace authority. */
const materialKindSchema = z.enum(['markdown', 'text']);

/** Material sensitivity classes exposed by the App API. */
const materialSensitivitySchema = z.enum(['public', 'internal', 'restricted']);

/** Canonical media types derived from one Material kind. */
const materialMediaTypeSchema = z.enum(['text/markdown', 'text/plain']);

/** Closed public projection of one Workspace Material. */
export const WorkspaceMaterialViewSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    materialId: MaterialIdSchema,
    title: z.string().min(1),
    kind: materialKindSchema,
    currentRevisionId: MaterialRevisionIdSchema.nullable(),
    sensitivity: materialSensitivitySchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

/** Closed public summary of one immutable Workspace Material revision. */
export const WorkspaceMaterialRevisionSummarySchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    materialId: MaterialIdSchema,
    revisionId: MaterialRevisionIdSchema,
    parentRevisionId: MaterialRevisionIdSchema.nullable(),
    mediaType: materialMediaTypeSchema,
    contentDigest: contentDigestSchema,
    authorId: opaqueIdSchema,
    createdAt: TimestampSchema,
  })
  .strict();

/** Closed public view of one immutable Workspace Material revision and its canonical content. */
export const WorkspaceMaterialRevisionViewSchema = WorkspaceMaterialRevisionSummarySchema.extend({
  content: z.string(),
  judgements: z.array(JudgementRecordReaderSchema).default([]),
}).strict();

/** Immutable Material target and base captured by one Artifact Review. */
export const ArtifactMaterialProposalSchema = z
  .object({
    materialId: MaterialIdSchema,
    baseRevisionId: MaterialRevisionIdSchema,
    baseContentDigest: contentDigestSchema,
  })
  .strict();

/** Attributable choice evidence retained on its exact version-owned Review. */
export const ArtifactReviewCandidateSelectionSchema = z
  .object({
    actorId: opaqueIdSchema,
    requestId: opaqueIdSchema,
    reason: z.string().min(1).nullable(),
    selectedAt: TimestampSchema,
  })
  .strict();

/** Closed public projection of one version-keyed Artifact Review. */
export const ArtifactReviewViewSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    reviewId: ArtifactReviewIdSchema,
    artifactId: ArtifactIdSchema,
    artifactVersion: z.number().int().positive(),
    contentDigest: contentDigestSchema,
    sourceThreadId: ThreadIdSchema.nullable(),
    sourceTurnId: TurnIdSchema.nullable(),
    sourceAgentId: opaqueIdSchema.nullable(),
    materialProposal: ArtifactMaterialProposalSchema.nullable(),
    decision: ArtifactReviewDecisionSchema.nullable(),
    decisionActorId: opaqueIdSchema.nullable(),
    feedback: z.string().min(1).nullable(),
    rangeFeedback: ArtifactReviewRangeFeedbackSchema.nullable().optional(),
    candidateSelections: z.array(ArtifactReviewCandidateSelectionSchema).default([]),
    judgements: z.array(JudgementRecordReaderSchema).default([]),
    decidedAt: TimestampSchema.nullable(),
    followUpTurnId: TurnIdSchema.nullable(),
    appliedMaterialRevisionId: MaterialRevisionIdSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const hasDecisionProof = value.decisionActorId !== null && value.decidedAt !== null;

    /**
     * Adds one Artifact Review tuple-coherence issue.
     *
     * @param message Human-readable validation failure.
     * @param path Field that violates the tuple contract.
     */
    const addDecisionIssue = (message: string, path: string): void => {
      context.addIssue({ code: 'custom', message, path: [path] });
    };

    if (value.rangeFeedback != null) {
      const range = value.rangeFeedback;
      const proposal = value.materialProposal;
      if (
        proposal === null ||
        range.materialId !== proposal.materialId ||
        range.revisionId !== proposal.baseRevisionId ||
        range.contentDigest !== proposal.baseContentDigest
      ) {
        addDecisionIssue(
          'Range feedback must identify the recorded Material proposal base.',
          'rangeFeedback'
        );
      }
      if (value.decision === null)
        addDecisionIssue('Range feedback requires a decision.', 'rangeFeedback');
    }

    if (value.decision === null) {
      if (
        value.decisionActorId !== null ||
        value.feedback !== null ||
        value.decidedAt !== null ||
        value.followUpTurnId !== null ||
        value.appliedMaterialRevisionId !== null
      ) {
        addDecisionIssue(
          'An unresolved Artifact Review cannot contain decision results.',
          'decision'
        );
      }
      return;
    }

    if (!hasDecisionProof) {
      addDecisionIssue('A decided Artifact Review requires actor and timestamp proof.', 'decision');
    }

    if (value.decision === 'needs_refinement' || value.decision === 'redo') {
      if (value.feedback === null || value.followUpTurnId === null) {
        addDecisionIssue('Refinement and redo require feedback and a follow-up Turn.', 'decision');
      }
      if (value.appliedMaterialRevisionId !== null) {
        addDecisionIssue('Refinement and redo cannot apply a Material revision.', 'decision');
      }
      return;
    }

    if (value.followUpTurnId !== null) {
      addDecisionIssue('Only refinement and redo may create a follow-up Turn.', 'followUpTurnId');
    }

    if (value.decision === 'accepted' && value.materialProposal !== null) {
      if (value.appliedMaterialRevisionId === null) {
        addDecisionIssue(
          'An accepted Material proposal requires its applied revision.',
          'decision'
        );
      }
    } else if (value.appliedMaterialRevisionId !== null) {
      addDecisionIssue('Only an accepted Material proposal may apply a revision.', 'decision');
    }
  });

/** Active delivery proof projected from the singular pending user-turn owner. */
export const ThreadMaterialActiveDeliverySchema = z
  .object({
    state: z.enum(['queued', 'applied']),
    pendingTurnId: TurnIdSchema,
    requestId: requestIdSchema,
    contentItemId: ItemIdSchema,
    goalId: opaqueIdSchema,
    activeTurnId: TurnIdSchema,
    materialId: MaterialIdSchema,
    revisionId: MaterialRevisionIdSchema,
    contentDigest: contentDigestSchema,
  })
  .strict();

/** Singular Material projection for one Thread. */
export const ThreadMaterialViewSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    resource: WorkspaceMaterialViewSchema,
    currentRevision: WorkspaceMaterialRevisionSummarySchema.nullable(),
    inclusionState: z.enum(['included', 'excluded']),
    latestQueuedRevisionId: MaterialRevisionIdSchema.nullable(),
    lastWorkerSeenRevisionId: MaterialRevisionIdSchema.nullable(),
    currentTurnRevisionId: MaterialRevisionIdSchema.nullable(),
    activeDelivery: ThreadMaterialActiveDeliverySchema.nullable(),
  })
  .strict();

/** App API response listing Workspace Materials. */
export const ListWorkspaceMaterialsResponseSchema = z
  .object({ materials: z.array(WorkspaceMaterialViewSchema) })
  .strict();

/** App API response reading one Workspace Material. */
export const GetWorkspaceMaterialResponseSchema = z
  .object({ material: WorkspaceMaterialViewSchema })
  .strict();

/** App API response listing immutable revisions for one Workspace Material. */
export const ListWorkspaceMaterialRevisionsResponseSchema = z
  .object({ revisions: z.array(WorkspaceMaterialRevisionSummarySchema) })
  .strict();

/** App API response reading one exact Workspace Material revision. */
export const GetWorkspaceMaterialRevisionResponseSchema = z
  .object({ revision: WorkspaceMaterialRevisionViewSchema })
  .strict();

/** App API response reading the singular Material projection for one Thread. */
export const GetThreadMaterialResponseSchema = z
  .object({ material: ThreadMaterialViewSchema.nullable() })
  .strict();

/** App API response listing version-keyed Artifact Reviews. */
export const ListArtifactReviewsResponseSchema = z
  .object({ reviews: z.array(ArtifactReviewViewSchema) })
  .strict();

/** Request payload for importing one immutable Workspace Artifact version. */
export const ImportWorkspaceArtifactRequestSchema = z
  .object({
    requestId: requestIdSchema,
    title: z.string().min(1).max(1024),
    mediaType: ArtifactMediaTypeSchema,
    contentDigest: contentDigestSchema,
    byteLength: z.number().int().min(0).max(MAX_ARTIFACT_FILE_BYTES),
  })
  .strict();

/** Response payload after importing one immutable Workspace Artifact version. */
export const ImportWorkspaceArtifactResponseSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    artifactVersion: z.literal(1),
  })
  .strict();

/** Request payload for introducing one exact Artifact version into a Thread. */
export const IntroduceWorkspaceArtifactRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedArtifactVersion: z.number().int().positive(),
  })
  .strict();

/** Response payload after introducing one exact Artifact version into a Thread. */
export const IntroduceWorkspaceArtifactResponseSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    artifactVersion: z.number().int().positive(),
    turnId: TurnIdSchema,
    itemId: ItemIdSchema,
  })
  .strict();

/** Request payload for deciding one version-keyed Artifact Review. */
export const SubmitArtifactReviewDecisionRequestSchema = z
  .object({
    requestId: requestIdSchema,
    decision: ArtifactReviewDecisionSchema,
    feedback: z.string().min(1).optional(),
    rangeFeedback: ArtifactReviewRangeFeedbackSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.decision === 'needs_refinement' || value.decision === 'redo') &&
      value.feedback === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Refinement and redo decisions require feedback.',
        path: ['feedback'],
      });
    }
  });

/** Response payload after deciding one version-keyed Artifact Review. */
export const SubmitArtifactReviewDecisionResponseSchema = z
  .object({
    reviewId: ArtifactReviewIdSchema,
    artifactId: ArtifactIdSchema,
    artifactVersion: z.number().int().positive(),
    decision: ArtifactReviewDecisionSchema,
    followUpTurnId: TurnIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const requiresFollowUp = value.decision === 'needs_refinement' || value.decision === 'redo';
    if (requiresFollowUp !== (value.followUpTurnId !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only refinement and redo decisions require a follow-up Turn.',
        path: ['followUpTurnId'],
      });
    }
  });

/** Request payload for choosing one exact available Artifact candidate. */
export const SelectArtifactReviewCandidateRequestSchema = z
  .object({
    requestId: requestIdSchema,
    contentDigest: contentDigestSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();

/** Response payload retaining all choice facts on the same version-owned Review. */
export const SelectArtifactReviewCandidateResponseSchema = z
  .object({ review: ArtifactReviewViewSchema })
  .strict();

/** Exact Material source range retained with a Review decision. */
export type ArtifactReviewRangeFeedback = z.infer<typeof ArtifactReviewRangeFeedbackSchema>;
/** One attributable choice of the Review's exact Artifact candidate. */
export type ArtifactReviewCandidateSelection = z.infer<
  typeof ArtifactReviewCandidateSelectionSchema
>;
/** Request for an exact candidate choice without starting work. */
export type SelectArtifactReviewCandidateRequest = z.infer<
  typeof SelectArtifactReviewCandidateRequestSchema
>;
/** Updated existing Review after an exact candidate choice. */
export type SelectArtifactReviewCandidateResponse = z.infer<
  typeof SelectArtifactReviewCandidateResponseSchema
>;

/** Request payload for creating one Workspace Material. */
export const CreateWorkspaceMaterialRequestSchema = z
  .object({
    requestId: requestIdSchema,
    title: z.string().min(1),
    kind: materialKindSchema,
    sensitivity: materialSensitivitySchema,
  })
  .strict();

/** Response payload after creating one Workspace Material. */
export const CreateWorkspaceMaterialResponseSchema = z
  .object({ materialId: MaterialIdSchema })
  .strict();

/** Request payload for saving one immutable Workspace Material revision. */
export const SaveWorkspaceMaterialRevisionRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedRevisionId: MaterialRevisionIdSchema.nullable(),
    contentDigest: contentDigestSchema,
    content: z.string(),
  })
  .strict();

/** Response payload after saving one immutable Workspace Material revision. */
export const SaveWorkspaceMaterialRevisionResponseSchema = z
  .object({
    materialId: MaterialIdSchema,
    revisionId: MaterialRevisionIdSchema,
  })
  .strict();

/** Request payload for binding one Material to a Thread. */
export const BindThreadMaterialRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedBindingState: z.enum(['not_bound']),
  })
  .strict();

/** Response payload after binding one Material to a Thread. */
export const BindThreadMaterialResponseSchema = z
  .object({
    materialId: MaterialIdSchema,
    threadId: ThreadIdSchema,
    outcome: z.literal('bound'),
  })
  .strict();

/** Request payload for unbinding one Material from a Thread. */
export const UnbindThreadMaterialRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedBindingState: z.literal('bound'),
  })
  .strict();

/** Response payload after unbinding one Material from a Thread. */
export const UnbindThreadMaterialResponseSchema = z
  .object({
    materialId: MaterialIdSchema,
    threadId: ThreadIdSchema,
    outcome: z.literal('unbound'),
  })
  .strict();

/** Request payload for excluding one bound Material from worker context. */
export const ExcludeThreadMaterialRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedBindingState: z.literal('bound'),
    expectedInclusionState: z.literal('included'),
    expectedQueuedRevisionId: MaterialRevisionIdSchema,
  })
  .strict();

/** Response payload after excluding one bound Material from worker context. */
export const ExcludeThreadMaterialResponseSchema = z
  .object({
    materialId: MaterialIdSchema,
    threadId: ThreadIdSchema,
    outcome: z.literal('excluded'),
  })
  .strict();

/** Request payload for restoring one bound Material to worker context. */
export const RestoreThreadMaterialRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedBindingState: z.literal('bound'),
    expectedInclusionState: z.literal('excluded'),
  })
  .strict();

/** Response payload after restoring one bound Material to worker context. */
export const RestoreThreadMaterialResponseSchema = z
  .object({
    materialId: MaterialIdSchema,
    threadId: ThreadIdSchema,
    outcome: z.literal('included'),
  })
  .strict();

/** Closed public projection of one Workspace Material. */
export type WorkspaceMaterialView = z.infer<typeof WorkspaceMaterialViewSchema>;
/** Closed public summary of one immutable Workspace Material revision. */
export type WorkspaceMaterialRevisionSummary = z.infer<
  typeof WorkspaceMaterialRevisionSummarySchema
>;
/** Closed public view of one immutable Workspace Material revision. */
export type WorkspaceMaterialRevisionView = z.infer<typeof WorkspaceMaterialRevisionViewSchema>;
/** Immutable Material target and base captured by one Artifact Review. */
export type ArtifactMaterialProposal = z.infer<typeof ArtifactMaterialProposalSchema>;
/** Closed public projection of one version-keyed Artifact Review. */
export type ArtifactReviewView = z.infer<typeof ArtifactReviewViewSchema>;
/** Active delivery proof projected from one pending user-turn owner. */
export type ThreadMaterialActiveDelivery = z.infer<typeof ThreadMaterialActiveDeliverySchema>;
/** Singular Material projection for one Thread. */
export type ThreadMaterialView = z.infer<typeof ThreadMaterialViewSchema>;
/** App API response listing Workspace Materials. */
export type ListWorkspaceMaterialsResponse = z.infer<typeof ListWorkspaceMaterialsResponseSchema>;
/** App API response reading one Workspace Material. */
export type GetWorkspaceMaterialResponse = z.infer<typeof GetWorkspaceMaterialResponseSchema>;
/** App API response listing immutable revisions for one Workspace Material. */
export type ListWorkspaceMaterialRevisionsResponse = z.infer<
  typeof ListWorkspaceMaterialRevisionsResponseSchema
>;
/** App API response reading one exact Workspace Material revision. */
export type GetWorkspaceMaterialRevisionResponse = z.infer<
  typeof GetWorkspaceMaterialRevisionResponseSchema
>;
/** App API response reading the singular Material projection for one Thread. */
export type GetThreadMaterialResponse = z.infer<typeof GetThreadMaterialResponseSchema>;
/** App API response listing version-keyed Artifact Reviews. */
export type ListArtifactReviewsResponse = z.infer<typeof ListArtifactReviewsResponseSchema>;
/** Request payload for importing one immutable Workspace Artifact version. */
export type ImportWorkspaceArtifactRequest = z.infer<typeof ImportWorkspaceArtifactRequestSchema>;
/** Response payload after importing one immutable Workspace Artifact version. */
export type ImportWorkspaceArtifactResponse = z.infer<typeof ImportWorkspaceArtifactResponseSchema>;
/** Request payload for introducing one exact Artifact version into a Thread. */
export type IntroduceWorkspaceArtifactRequest = z.infer<
  typeof IntroduceWorkspaceArtifactRequestSchema
>;
/** Response payload after introducing one exact Artifact version into a Thread. */
export type IntroduceWorkspaceArtifactResponse = z.infer<
  typeof IntroduceWorkspaceArtifactResponseSchema
>;
/** Request payload for deciding one version-keyed Artifact Review. */
export type SubmitArtifactReviewDecisionRequest = z.infer<
  typeof SubmitArtifactReviewDecisionRequestSchema
>;
/** Response payload after deciding one version-keyed Artifact Review. */
export type SubmitArtifactReviewDecisionResponse = z.infer<
  typeof SubmitArtifactReviewDecisionResponseSchema
>;
/** Request payload for creating one Workspace Material. */
export type CreateWorkspaceMaterialRequest = z.infer<typeof CreateWorkspaceMaterialRequestSchema>;
/** Response payload after creating one Workspace Material. */
export type CreateWorkspaceMaterialResponse = z.infer<typeof CreateWorkspaceMaterialResponseSchema>;
/** Request payload for saving one immutable Workspace Material revision. */
export type SaveWorkspaceMaterialRevisionRequest = z.infer<
  typeof SaveWorkspaceMaterialRevisionRequestSchema
>;
/** Response payload after saving one immutable Workspace Material revision. */
export type SaveWorkspaceMaterialRevisionResponse = z.infer<
  typeof SaveWorkspaceMaterialRevisionResponseSchema
>;
/** Request payload for binding one Material to a Thread. */
export type BindThreadMaterialRequest = z.infer<typeof BindThreadMaterialRequestSchema>;
/** Response payload after binding one Material to a Thread. */
export type BindThreadMaterialResponse = z.infer<typeof BindThreadMaterialResponseSchema>;
/** Request payload for unbinding one Material from a Thread. */
export type UnbindThreadMaterialRequest = z.infer<typeof UnbindThreadMaterialRequestSchema>;
/** Response payload after unbinding one Material from a Thread. */
export type UnbindThreadMaterialResponse = z.infer<typeof UnbindThreadMaterialResponseSchema>;
/** Request payload for excluding one bound Material from worker context. */
export type ExcludeThreadMaterialRequest = z.infer<typeof ExcludeThreadMaterialRequestSchema>;
/** Response payload after excluding one bound Material from worker context. */
export type ExcludeThreadMaterialResponse = z.infer<typeof ExcludeThreadMaterialResponseSchema>;
/** Request payload for restoring one bound Material to worker context. */
export type RestoreThreadMaterialRequest = z.infer<typeof RestoreThreadMaterialRequestSchema>;
/** Response payload after restoring one bound Material to worker context. */
export type RestoreThreadMaterialResponse = z.infer<typeof RestoreThreadMaterialResponseSchema>;

/** One paged, validated file member of a disposable exact-source ZIP snapshot. */
export const ArtifactFolderEntrySchema = z
  .object({
    relativePath: z.string().min(1).max(4096),
    byteLength: z.number().int().nonnegative().max(4_000_000_000),
    contentDigest: contentDigestSchema,
  })
  .strict();

/** Truthful cache availability; the original Artifact remains its sole durable source. */
export const ArtifactFolderSnapshotResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      artifactId: ArtifactIdSchema,
      artifactVersion: z.number().int().positive(),
      originalDigest: contentDigestSchema,
      originalRetained: z.literal(true),
      processor: z.literal('openkit.zip.v1'),
      representationDigest: contentDigestSchema,
      expandedBytes: z.number().int().nonnegative().max(4_000_000_000),
      fileCount: z.number().int().nonnegative().max(100_000),
      directoryCount: z.number().int().nonnegative().max(131_072),
      entries: z.array(ArtifactFolderEntrySchema).max(100),
      nextOffset: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      artifactId: ArtifactIdSchema,
      artifactVersion: z.number().int().positive(),
      originalDigest: contentDigestSchema,
      originalRetained: z.literal(true),
      reason: z.enum(['not_extracted', 'extraction_failed']),
    })
    .strict(),
]);

/** Bounded source-bound folder projection used by API and Web consumers. */
export type ArtifactFolderSnapshotResponse = z.infer<typeof ArtifactFolderSnapshotResponseSchema>;
