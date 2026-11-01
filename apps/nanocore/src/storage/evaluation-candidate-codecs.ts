import {
  CandidateSetRecordReaderSchema,
  CandidateSetRecordSchema,
  JudgementRecordSchema,
} from '@openkit/app-api-schemas';
import { TimestampSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

const receipt = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'evaluation.candidate-set-create',
      'evaluation.candidate-set-select',
      'evaluation.judgement-add',
    ]),
    requestId: z.string().min(1),
    scope: z
      .object({ workspaceId: WorkspaceIdSchema, candidateSetId: z.string().min(1).optional() })
      .strict(),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.enum(['evaluation_candidate_set', 'evaluation_judgement']),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

/** Exact candidate membership/history tuple and its original command receipt; no caller SQL or callback crosses the owner. */
export const ControlEvaluationCandidateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), record: CandidateSetRecordSchema, receipt }).strict(),
  z.object({ mode: z.literal('append'), judgement: JudgementRecordSchema, receipt }).strict(),
]);
/** Complete domain input uses the existing cloned-envelope byte account. */
export type ControlEvaluationCandidate = z.infer<typeof ControlEvaluationCandidateSchema>;
/** The complete known-field record is returned after the covering FULL commit, without a second read. */
export const ControlEvaluationCandidateResultSchema = CandidateSetRecordReaderSchema;

/** Closed product-safe failures; private SQLite messages never cross this boundary. */
export class EvaluationCandidateCommandError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_request' | 'conflict' | 'recovery_required',
    message: string
  ) {
    super(message);
  }
  /** The existing public refusal status, unchanged by the native move. */
  get status(): number {
    return this.code === 'not_found' ? 404 : this.code === 'invalid_request' ? 400 : 409;
  }
}
