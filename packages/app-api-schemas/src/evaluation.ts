import {
  MaterialIdSchema,
  MaterialRevisionIdSchema,
  TimestampSchema,
  UserActorRefSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { ConversationArtifactReferenceSchema } from './chat-mode.js';
import { ArtifactReviewRangeFeedbackSchema } from './material.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const descriptiveExtensions = z.record(z.string(), z.json());

/** Exact candidate identity reuses the ordinary conversation pin with its retained byte digest. */
export const EvaluationCandidateSchema = ConversationArtifactReferenceSchema.extend({
  contentDigest: digest,
});

/** Exact original Material range uses the existing Review offsets and states their retained unit. */
export const MaterialJudgementTargetSchema = ArtifactReviewRangeFeedbackSchema.safeExtend({
  kind: z.literal('material-range'),
  offsetUnit: z.literal('utf-16'),
});

/** Candidate-set identity stays scoped to its owning Workspace and accepted creation request. */
export const CandidateSetJudgementTargetSchema = z.object({
  kind: z.literal('candidate-set'),
  candidateSetId: z.string().min(1),
});

/** Closed exact target families; none is a universal Resource identity. */
export const JudgementTargetSchema = z.union([
  EvaluationCandidateSchema.extend({ kind: z.literal('artifact-version') }),
  MaterialJudgementTargetSchema,
  CandidateSetJudgementTargetSchema,
]);

const judgementFields = {
  formatVersion: z.literal(1),
  workspaceId: WorkspaceIdSchema,
  requestId: z.string().min(1),
  actor: UserActorRefSchema,
  recordedAt: TimestampSchema,
  note: z.string().min(1).nullable(),
  extensions: descriptiveExtensions,
};

/** Selection is attributable human judgement on one immutable set member. */
export const CandidateSelectionJudgementSchema = z.object({
  ...judgementFields,
  kind: z.literal('select'),
  target: CandidateSetJudgementTargetSchema,
  choice: EvaluationCandidateSchema,
});

const resultingMaterialRevision = z.object({
  materialId: MaterialIdSchema,
  revisionId: MaterialRevisionIdSchema,
  contentDigest: digest,
});
const correctionChoice = z.discriminatedUnion('outcome', [
  z.object({
    replacementText: z.string(),
    outcome: z.literal('apply'),
    resultingRevision: resultingMaterialRevision,
  }),
  z.object({
    replacementText: z.string(),
    outcome: z.literal('reject'),
    resultingRevision: z.null(),
  }),
]);
const ratingChoice = z
  .object({ value: z.number(), lowerBound: z.number(), upperBound: z.number() })
  .refine(
    (choice) =>
      choice.lowerBound < choice.upperBound &&
      choice.value >= choice.lowerBound &&
      choice.value <= choice.upperBound,
    { message: 'The rating must lie within its explicit scale.' }
  );

/** Immutable human assessment with a closed kind, exact target and typed choice. */
export const JudgementRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    ...judgementFields,
    kind: z.literal('accept'),
    target: JudgementTargetSchema,
    choice: z.null(),
  }),
  z.object({
    ...judgementFields,
    kind: z.literal('reject'),
    target: JudgementTargetSchema,
    choice: z.null(),
  }),
  z.object({
    ...judgementFields,
    kind: z.literal('correct'),
    target: MaterialJudgementTargetSchema,
    choice: correctionChoice,
  }),
  CandidateSelectionJudgementSchema,
  z.object({
    ...judgementFields,
    kind: z.literal('rate'),
    target: JudgementTargetSchema,
    choice: ratingChoice,
  }),
]);

/** Retained ordered membership and selection history; current choice is a projection. */
export const CandidateSetRecordSchema = z
  .object({
    formatVersion: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    candidateSetId: z.string().min(1),
    createdBy: UserActorRefSchema,
    createdAt: TimestampSchema,
    candidates: z.array(EvaluationCandidateSchema).min(2),
    selections: z.array(CandidateSelectionJudgementSchema),
    extensions: descriptiveExtensions,
  })
  .superRefine((set, context) => {
    const identities = set.candidates.map((candidate) =>
      JSON.stringify([candidate.artifactId, candidate.artifactVersion])
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: 'custom', message: 'A candidate version can occur only once.' });
    }
    for (const selection of set.selections) {
      if (
        selection.workspaceId !== set.workspaceId ||
        selection.target.candidateSetId !== set.candidateSetId ||
        !set.candidates.some(
          (candidate) =>
            candidate.artifactId === selection.choice.artifactId &&
            candidate.artifactVersion === selection.choice.artifactVersion &&
            candidate.contentDigest === selection.choice.contentDigest
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A selection must identify an exact member of its owning set.',
        });
      }
    }
  });

/** Exact version reference available for comparison and ordinary pinned input. */
export type EvaluationCandidate = z.infer<typeof EvaluationCandidateSchema>;
/** Immutable attributable assessment owned by its exact target. */
export type JudgementRecord = z.infer<typeof JudgementRecordSchema>;
/** Immutable candidate membership with append-only human choices. */
export type CandidateSetRecord = z.infer<typeof CandidateSetRecordSchema>;
