import { readRetainedV1, UserActorRefSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  CandidateSetJudgementTargetSchema,
  CandidateSetRecordSchema,
  EvaluationCandidateSchema,
  JudgementRecordSchema,
  MaterialJudgementTargetSchema,
} from './evaluation.js';

/** Adapts shared marker refusal to schema admission without interpreting family fields first. */
function retainedV1Input(value: unknown): unknown {
  try {
    return readRetainedV1(value, (record) => record);
  } catch {
    return undefined;
  }
}

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
const judgementReader = z.discriminatedUnion('kind', [
  accept.safeExtend({ actor, target }),
  reject.safeExtend({ actor, target }),
  correct.safeExtend({ actor, target: materialRange }),
  select.safeExtend({ actor, target: candidateSet, choice: candidate }),
  rate.safeExtend({ actor, target }),
]);

/** Checks the shared marker before interpreting any retained judgement. */
export const JudgementRecordReaderSchema = z.preprocess(retainedV1Input, judgementReader);

/** Retained membership reads use the same coherence predicates without applying strict command admission to descriptions. */
const candidateSetReader = CandidateSetRecordSchema.safeExtend({
  createdBy: actor,
  candidates: z.array(candidate).min(2),
  judgements: z.array(judgementReader),
});

/** Checks the shared marker before reading immutable membership and nested judgements. */
export const CandidateSetRecordReaderSchema = z.preprocess(retainedV1Input, candidateSetReader);
