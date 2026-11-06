import {
  ArtifactMaterialProposalSchema,
  ArtifactReviewRangeFeedbackSchema,
  ArtifactReviewViewSchema,
  JudgementRecordSchema,
  SelectArtifactReviewCandidateRequestSchema,
  SubmitArtifactReviewDecisionRequestSchema,
  SubmitArtifactReviewDecisionResponseSchema,
} from '@openkit/app-api-schemas';
import {
  ActorRefSchema,
  AgentSessionIdSchema,
  ArtifactIdSchema,
  ArtifactSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { ControlProductTransitionSchema } from './storage/control-store-products.js';

/** Closed structural failures raised by the Artifact Review authority. */
export type ArtifactReviewErrorCode =
  | 'conflict'
  | 'idempotency_key_conflict'
  | 'invalid_request'
  | 'recovery_required'
  | 'stale';

/** Nominal native Review refusal; only the Artifact family supplies operation framing. */
export class ArtifactReviewError extends Error {
  readonly status: 400 | 409;
  constructor(
    readonly code: ArtifactReviewErrorCode,
    message: string
  ) {
    super(message);
    this.status = code === 'invalid_request' ? 400 : 409;
  }
}

/** Original Review and submission receipt facts; the response comes only from the complete native body. */
const ControlReviewReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'artifact.submit',
      'artifact.review.select',
      'artifact.review.decide',
      'evaluation.judgement-add',
    ]),
    requestId: z.string().min(1),
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().min(1),
    responseKind: z.enum(['artifact', 'artifact_review', 'evaluation_judgement']),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

/** Existing exact version Review publication facts, independent of its file owner. */
const ControlReviewPublicationSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    artifactVersion: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceThreadId: ThreadIdSchema.nullable(),
    sourceTurnId: TurnIdSchema.nullable(),
    sourceAgentId: z.string().min(1).nullable(),
    materialProposal: ArtifactMaterialProposalSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict();

const ControlReviewReplaySchema = z
  .object({
    actorId: z.string().min(1),
    artifactId: ArtifactIdSchema,
    artifactVersion: z.number().int().positive(),
    decision: SubmitArtifactReviewDecisionRequestSchema.shape.decision,
    feedback: z.string().nullable(),
    rangeFeedback: ArtifactReviewRangeFeedbackSchema.nullable().optional(),
    requestId: z.string().min(1),
  })
  .strict();

const ControlReviewDecisionSchema = ControlReviewReplaySchema.extend({
  actor: ActorRefSchema,
  decidedAt: TimestampSchema,
  artifactContent: z.string().nullable(),
  artifactOriginal: z
    .object({
      byteLength: z.number().int().nonnegative(),
      contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict()
    .optional(),
  artifactMediaType: z.string().min(1),
  artifactFile: z
    .object({
      byteLength: z.number().int().nonnegative(),
      contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict()
    .optional(),
}).superRefine((input, context) => {
  if (
    input.artifactOriginal !== undefined
      ? input.artifactContent !== null || input.artifactFile !== undefined
      : input.artifactContent === null
        ? !input.artifactFile
        : input.artifactFile !== undefined ||
          !['text/plain', 'text/markdown', 'application/json'].includes(input.artifactMediaType)
  )
    context.addIssue({ code: 'custom', message: 'Review content proof is contradictory.' });
});

/** Closed commands for the accepted Review family; files and follow-up admission retain their existing owners. */
export const ControlReviewCommandInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('submit'),
      artifact: ArtifactSchema,
      review: ControlReviewPublicationSchema,
      agentSessionId: AgentSessionIdSchema,
      agentId: z.string().min(1),
      receipt: ControlReviewReceiptSchema,
      // The Review and product owners share a value cycle; resolve its schema only at parse time.
      transition: z.lazy(() => ControlProductTransitionSchema),
    })
    .strict(),
  z
    .object({
      mode: z.literal('judgement'),
      publication: ControlReviewPublicationSchema.nullable(),
      judgement: JudgementRecordSchema,
      receipt: ControlReviewReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('select'),
      input: SelectArtifactReviewCandidateRequestSchema.extend({
        actorId: z.string().min(1),
        artifactId: ArtifactIdSchema,
        artifactVersion: z.number().int().positive(),
        selectedAt: TimestampSchema,
      }).strict(),
      receipt: ControlReviewReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('decide'),
      input: ControlReviewDecisionSchema,
      receipt: ControlReviewReceiptSchema.nullable(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('decision-receipt'),
      input: ControlReviewReplaySchema,
      receipt: ControlReviewReceiptSchema,
    })
    .strict(),
]);

/** Cloneable, bounded input to the existing database worker. */
export type ControlReviewCommandInput = z.infer<typeof ControlReviewCommandInputSchema>;

/** The existing exact command result, returned only after the worker's outer FULL commit. */
export const ControlReviewCommandResultSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('submit'),
      value: z.object({ artifactId: ArtifactIdSchema }).strict(),
      replayed: z.boolean(),
    })
    .strict(),
  z
    .object({ mode: z.literal('judgement'), value: JudgementRecordSchema, replayed: z.boolean() })
    .strict(),
  z
    .object({ mode: z.literal('select'), value: ArtifactReviewViewSchema, replayed: z.boolean() })
    .strict(),
  z
    .object({
      mode: z.literal('decide'),
      value: SubmitArtifactReviewDecisionResponseSchema,
      replayed: z.boolean(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('decision-receipt'),
      value: SubmitArtifactReviewDecisionResponseSchema,
      replayed: z.boolean(),
    })
    .strict(),
]);

/** Materialized Review result, with no cursor or mutable Store cache. */
export type ControlReviewCommandResult = z.infer<typeof ControlReviewCommandResultSchema>;
