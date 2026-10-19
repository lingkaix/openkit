import {
  ArtifactIdSchema,
  ArtifactReviewIdSchema,
  MaterialIdSchema,
  MaterialRevisionIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Frozen v1 digest, actor and decision meanings; wire schema changes do not select retained history. */
const contentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().min(1);
const ArtifactReviewDecisionSchema = z.enum([
  'accepted',
  'needs_refinement',
  'redo',
  'rejected',
  'deferred',
]);

/** Immutable Material target and base captured by one Artifact Review. */
const ArtifactMaterialProposalSchema = z
  .object({
    materialId: MaterialIdSchema,
    baseRevisionId: MaterialRevisionIdSchema,
    baseContentDigest: contentDigestSchema,
  })
  .passthrough();

/** Exact original-source UTF-16 range on one immutable Material proposal base. */
const ArtifactReviewRangeFeedbackSchema = z
  .object({
    materialId: MaterialIdSchema,
    revisionId: MaterialRevisionIdSchema,
    contentDigest: contentDigestSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    originalText: z.string().min(1),
  })
  .passthrough()
  .refine((range) => range.start < range.end, {
    message: 'The range end must follow its start.',
    path: ['end'],
  });

/** Attributable choice evidence retained on its exact version-owned Review. */
const ArtifactReviewCandidateSelectionSchema = z
  .object({
    actorId: opaqueIdSchema,
    requestId: opaqueIdSchema,
    reason: z.string().min(1).nullable(),
    selectedAt: TimestampSchema,
  })
  .passthrough();

/** Version 1 retained Review tuple, independent of the current API projection. */
export const StoredArtifactReviewV1Schema = z
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
    decidedAt: TimestampSchema.nullable(),
    followUpTurnId: TurnIdSchema.nullable(),
    appliedMaterialRevisionId: MaterialRevisionIdSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .passthrough()
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
