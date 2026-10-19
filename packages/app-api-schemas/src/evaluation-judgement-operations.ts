import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { JudgementRecordSchema, MaterialJudgementTargetSchema } from './evaluation.js';
import type { OperationDefinition } from './operation-contract.js';

const [accept, reject, , , rate] = JudgementRecordSchema.options;
const serverFields = {
  formatVersion: true,
  actor: true,
  recordedAt: true,
  workspaceId: true,
  requestId: true,
} as const;
const optionalDescriptions = {
  note: z.string().min(1).nullable().default(null),
  extensions: z.record(z.string(), z.json()).default({}),
};

/** A human assessment carries no caller-selected actor, time or content effect. */
const assessment = z.discriminatedUnion('kind', [
  accept.omit(serverFields).extend(optionalDescriptions).strict(),
  reject.omit(serverFields).extend(optionalDescriptions).strict(),
  rate.omit(serverFields).extend(optionalDescriptions).strict(),
]);

/** Ordinary Workspace selectors wrap the closed human assessment without trusted record metadata. */
export const RecordEvaluationJudgementRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    requestId: z.string().min(1),
    judgement: assessment,
  })
  .strict();

/** One exact-range correction requests an existing Material revision effect or explicit rejection. */
export const CorrectMaterialRangeRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    requestId: z.string().min(1),
    target: MaterialJudgementTargetSchema,
    replacementText: z.string(),
    decision: z.enum(['apply', 'reject']),
    ...optionalDescriptions,
  })
  .strict();

/** The retained assessment is the command result; applied content stays in its Material revision owner. */
export const RecordEvaluationJudgementResponseSchema = z.object({
  judgement: JudgementRecordSchema,
});

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** Exact human judgements and the existing Material correction effect use ordinary Workspace admission. */
export const EVALUATION_JUDGEMENT_OPERATION_DEFINITIONS = {
  'evaluation.judgement-add': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 201,
    description: 'Record an attributable human assessment of an exact output or candidate set.',
    inputSchema: RecordEvaluationJudgementRequestSchema,
    outputSchema: RecordEvaluationJudgementResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'material.range-correct': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 201,
    description: 'Apply or reject one replacement on an exact original Material revision range.',
    inputSchema: CorrectMaterialRangeRequestSchema,
    outputSchema: RecordEvaluationJudgementResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;

/** Caller-authored assessment of an exact retained target. */
export type RecordEvaluationJudgementRequest = z.infer<
  typeof RecordEvaluationJudgementRequestSchema
>;
/** Exact source and replacement selected by a human. */
export type CorrectMaterialRangeRequest = z.infer<typeof CorrectMaterialRangeRequestSchema>;
/** Immutable assessment returned from its target owner. */
export type RecordEvaluationJudgementResponse = z.infer<
  typeof RecordEvaluationJudgementResponseSchema
>;
