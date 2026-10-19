import { UserActorRefSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  CandidateSetJudgementTargetSchema,
  CandidateSetRecordSchema,
  EvaluationCandidateSchema,
  JudgementRecordSchema,
  MaterialJudgementTargetSchema,
} from './evaluation.js';

const actor = UserActorRefSchema.strip();
const candidate = EvaluationCandidateSchema.strip();
const materialRange = MaterialJudgementTargetSchema.strip();
const candidateSet = CandidateSetJudgementTargetSchema.strip();
const target = z.union([
  candidate.extend({ kind: z.literal('artifact-version') }),
  materialRange,
  candidateSet,
]);
const [accept, reject, correct, select, rate] = JudgementRecordSchema.options;

/** Retained judgement reads ignore descriptive additions while preserving closed kinds and exact known fields. */
export const JudgementRecordReaderSchema = z.discriminatedUnion('kind', [
  accept.safeExtend({ actor, target }),
  reject.safeExtend({ actor, target }),
  correct.safeExtend({ actor, target: materialRange }),
  select.safeExtend({ actor, target: candidateSet, choice: candidate }),
  rate.safeExtend({ actor, target }),
]);

/** Retained membership reads use the same coherence predicates without applying strict command admission to descriptions. */
export const CandidateSetRecordReaderSchema = CandidateSetRecordSchema.safeExtend({
  createdBy: actor,
  candidates: z.array(candidate).min(2),
  judgements: z.array(JudgementRecordReaderSchema),
});
