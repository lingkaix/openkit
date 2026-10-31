import { createHash } from 'node:crypto';
import {
  ArtifactMaterialProposalSchema,
  ArtifactReviewRangeFeedbackSchema,
} from '@openkit/app-api-schemas';
import {
  ArtifactIdSchema,
  ArtifactReviewIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Closed worker request used only by an accepted Artifact Review refinement or redo. */
export const ArtifactReviewFollowUpRequestSchema = z
  .object({
    kind: z.literal('artifact-review-follow-up'),
    workspaceId: WorkspaceIdSchema,
    reviewId: ArtifactReviewIdSchema,
    artifactId: ArtifactIdSchema,
    artifactVersion: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    artifactContent: z.string().min(1).nullable(),
    artifactMediaType: z.string().min(1).max(255),
    artifactFile: z
      .object({
        byteLength: z.number().int().min(0).max(1_000_000_000),
        contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    sourceThreadId: ThreadIdSchema,
    sourceTurnId: TurnIdSchema,
    sourceAgentId: z.string().min(1),
    materialProposal: ArtifactMaterialProposalSchema.nullable(),
    rangeFeedback: ArtifactReviewRangeFeedbackSchema.optional(),
    decision: z.enum(['needs_refinement', 'redo']),
    feedback: z.string().min(1),
    decisionRequestId: z.string().min(1),
    workerRequestId: z.string().min(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.rangeFeedback !== undefined &&
      (request.materialProposal === null ||
        request.rangeFeedback.materialId !== request.materialProposal.materialId ||
        request.rangeFeedback.revisionId !== request.materialProposal.baseRevisionId ||
        request.rangeFeedback.contentDigest !== request.materialProposal.baseContentDigest)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Range feedback must identify the recorded Material proposal base.',
        path: ['rangeFeedback'],
      });
    }
    if (request.artifactContent === null) {
      if (
        !request.artifactFile ||
        request.artifactFile.contentDigest !== request.contentDigest ||
        request.materialProposal !== null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Artifact file follow-up proof is contradictory.',
          path: ['artifactFile'],
        });
      }
      return;
    }
    const digest = `sha256:${createHash('sha256').update(request.artifactContent).digest('hex')}`;
    if (
      request.contentDigest !== digest ||
      request.artifactFile !== undefined ||
      !['text/markdown', 'text/plain', 'application/json'].includes(request.artifactMediaType)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact Review follow-up content digest is contradictory.',
        path: ['artifactContent'],
      });
    }
  });

/** Exact worker request carried by an Artifact Review follow-up Turn. */
export type ArtifactReviewFollowUpRequest = z.infer<typeof ArtifactReviewFollowUpRequestSchema>;

/**
 * Serializes one validated Artifact Review follow-up request.
 *
 * @param request Exact Review, Artifact, source, feedback, and request lineage.
 * @returns Compact JSON accepted by the worker Context Package boundary.
 * @throws z.ZodError when the request is incomplete or contradictory.
 */
export function serializeArtifactReviewFollowUpRequest(
  request: ArtifactReviewFollowUpRequest
): string {
  return JSON.stringify(ArtifactReviewFollowUpRequestSchema.parse(request));
}
