import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { ArtifactReviewDecisionSchema } from './action-center.js';

/** Opaque non-empty identifier used by app-local Material contracts. */
const opaqueIdSchema = z.string().min(1);

/** Lowercase SHA-256 digest over exact canonical content bytes. */
const contentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Caller-supplied idempotency key excluding reserved import lineage. */
const requestIdSchema = opaqueIdSchema.refine((value) => !value.startsWith('import-lineage:'), {
  message: 'requestId uses a reserved import-lineage prefix',
});

/** Material kinds supported by the app-local Workspace authority. */
const materialKindSchema = z.enum(['markdown', 'text']);

/** Material sensitivity classes exposed by the App API. */
const materialSensitivitySchema = z.enum(['public', 'internal', 'restricted']);

/** Canonical media types derived from one Material kind. */
const materialMediaTypeSchema = z.enum(['text/markdown', 'text/plain']);

/** Closed public projection of one Workspace Material. */
export const WorkspaceMaterialViewSchema = z
  .object({
    workspaceId: opaqueIdSchema,
    materialId: opaqueIdSchema,
    title: z.string().min(1),
    kind: materialKindSchema,
    currentRevisionId: opaqueIdSchema.nullable(),
    sensitivity: materialSensitivitySchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

/** Closed public summary of one immutable Workspace Material revision. */
export const WorkspaceMaterialRevisionSummarySchema = z
  .object({
    workspaceId: opaqueIdSchema,
    materialId: opaqueIdSchema,
    revisionId: opaqueIdSchema,
    parentRevisionId: opaqueIdSchema.nullable(),
    mediaType: materialMediaTypeSchema,
    contentDigest: contentDigestSchema,
    authorId: opaqueIdSchema,
    createdAt: TimestampSchema,
  })
  .strict();

/** Closed public view of one immutable Workspace Material revision and its canonical content. */
export const WorkspaceMaterialRevisionViewSchema = WorkspaceMaterialRevisionSummarySchema.extend({
  content: z.string(),
}).strict();

/** Immutable Material target and base captured by one Artifact Review. */
export const ArtifactMaterialProposalSchema = z
  .object({
    materialId: opaqueIdSchema,
    baseRevisionId: opaqueIdSchema,
    baseContentDigest: contentDigestSchema,
  })
  .strict();

/** Closed public projection of one version-keyed Artifact Review. */
export const ArtifactReviewViewSchema = z
  .object({
    workspaceId: opaqueIdSchema,
    reviewId: opaqueIdSchema,
    artifactId: opaqueIdSchema,
    artifactVersion: z.number().int().positive(),
    contentDigest: contentDigestSchema,
    sourceThreadId: opaqueIdSchema.nullable(),
    sourceTurnId: opaqueIdSchema.nullable(),
    sourceAgentId: opaqueIdSchema.nullable(),
    materialProposal: ArtifactMaterialProposalSchema.nullable(),
    decision: ArtifactReviewDecisionSchema.nullable(),
    decisionActorId: opaqueIdSchema.nullable(),
    feedback: z.string().min(1).nullable(),
    decidedAt: TimestampSchema.nullable(),
    followUpTurnId: opaqueIdSchema.nullable(),
    appliedMaterialRevisionId: opaqueIdSchema.nullable(),
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
    pendingTurnId: opaqueIdSchema,
    requestId: requestIdSchema,
    contentItemId: opaqueIdSchema,
    goalId: opaqueIdSchema,
    activeTurnId: opaqueIdSchema,
    materialId: opaqueIdSchema,
    revisionId: opaqueIdSchema,
    contentDigest: contentDigestSchema,
  })
  .strict();

/** Singular Material projection for one Thread. */
export const ThreadMaterialViewSchema = z
  .object({
    workspaceId: opaqueIdSchema,
    threadId: opaqueIdSchema,
    resource: WorkspaceMaterialViewSchema,
    currentRevision: WorkspaceMaterialRevisionSummarySchema.nullable(),
    inclusionState: z.enum(['included', 'excluded']),
    latestQueuedRevisionId: opaqueIdSchema.nullable(),
    lastWorkerSeenRevisionId: opaqueIdSchema.nullable(),
    currentTurnRevisionId: opaqueIdSchema.nullable(),
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
    title: z.string().min(1),
    mediaType: z.enum(['text/markdown', 'text/plain', 'application/json']),
    contentDigest: contentDigestSchema,
    content: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mediaType !== 'application/json') {
      return;
    }
    try {
      JSON.parse(value.content);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'application/json content must be syntactically valid JSON',
        path: ['content'],
      });
    }
  });

/** Response payload after importing one immutable Workspace Artifact version. */
export const ImportWorkspaceArtifactResponseSchema = z
  .object({
    artifactId: opaqueIdSchema,
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
    artifactId: opaqueIdSchema,
    artifactVersion: z.number().int().positive(),
    turnId: opaqueIdSchema,
    itemId: opaqueIdSchema,
  })
  .strict();

/** Request payload for deciding one version-keyed Artifact Review. */
export const SubmitArtifactReviewDecisionRequestSchema = z
  .object({
    requestId: requestIdSchema,
    decision: ArtifactReviewDecisionSchema,
    feedback: z.string().min(1).optional(),
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
    reviewId: opaqueIdSchema,
    artifactId: opaqueIdSchema,
    artifactVersion: z.number().int().positive(),
    decision: ArtifactReviewDecisionSchema,
    followUpTurnId: opaqueIdSchema.nullable(),
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
  .object({ materialId: opaqueIdSchema })
  .strict();

/** Request payload for saving one immutable Workspace Material revision. */
export const SaveWorkspaceMaterialRevisionRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedRevisionId: opaqueIdSchema.nullable(),
    contentDigest: contentDigestSchema,
    content: z.string(),
  })
  .strict();

/** Response payload after saving one immutable Workspace Material revision. */
export const SaveWorkspaceMaterialRevisionResponseSchema = z
  .object({
    materialId: opaqueIdSchema,
    revisionId: opaqueIdSchema,
  })
  .strict();

/** Request payload for binding one Material to a Thread. */
export const BindThreadMaterialRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedBindingState: z.enum(['absent', 'unbound']),
  })
  .strict();

/** Response payload after binding one Material to a Thread. */
export const BindThreadMaterialResponseSchema = z
  .object({
    materialId: opaqueIdSchema,
    threadId: opaqueIdSchema,
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
    materialId: opaqueIdSchema,
    threadId: opaqueIdSchema,
    outcome: z.literal('unbound'),
  })
  .strict();

/** Request payload for excluding one bound Material from worker context. */
export const ExcludeThreadMaterialRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedBindingState: z.literal('bound'),
    expectedInclusionState: z.literal('included'),
    expectedQueuedRevisionId: opaqueIdSchema,
  })
  .strict();

/** Response payload after excluding one bound Material from worker context. */
export const ExcludeThreadMaterialResponseSchema = z
  .object({
    materialId: opaqueIdSchema,
    threadId: opaqueIdSchema,
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
    materialId: opaqueIdSchema,
    threadId: opaqueIdSchema,
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
