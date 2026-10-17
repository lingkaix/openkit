import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { CandidateSetRecordSchema, EvaluationCandidateSchema } from './evaluation.js';
import type { OperationDefinition } from './operation-contract.js';

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;
const workspace = { workspaceId: WorkspaceIdSchema };
const set = { ...workspace, candidateSetId: z.string().min(1) };
const requestId = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('import-lineage:'), {
    message: 'requestId uses a reserved import-lineage prefix',
  });

/** Creates immutable ordered membership; the accepted request is its Workspace-scoped identity. */
export const CreateCandidateSetRequestSchema = z
  .object({
    ...workspace,
    requestId,
    candidates: z.array(EvaluationCandidateSchema.strict()).min(2),
  })
  .strict();

/** Appends one explicit human choice without starting work or changing membership. */
export const SelectCandidateSetRequestSchema = z
  .object({
    ...set,
    requestId,
    choice: EvaluationCandidateSchema.strict(),
    note: z.string().min(1).optional(),
  })
  .strict();

/** Complete visible sets; no partially admitted membership is projected. */
export const ListCandidateSetsResponseSchema = z.object({
  items: z.array(CandidateSetRecordSchema),
});

/** Public input for immutable candidate membership. */
export type CreateCandidateSetRequest = z.infer<typeof CreateCandidateSetRequestSchema>;
/** Public input for an attributable selection. */
export type SelectCandidateSetRequest = z.infer<typeof SelectCandidateSetRequestSchema>;

/** Candidate membership and human selection use the ordinary Workspace JSON family. */
export const EVALUATION_OPERATION_DEFINITIONS = {
  'evaluation.candidate-set-create': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 201,
    description: 'Create immutable ordered membership of exact Artifact versions.',
    inputSchema: CreateCandidateSetRequestSchema,
    outputSchema: CandidateSetRecordSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.write',
    mutating: true,
  },
  'evaluation.candidate-set-list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List complete candidate sets admitted by every current source audience.',
    inputSchema: z.object(workspace).strict(),
    outputSchema: ListCandidateSetsResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'evaluation.candidate-set-read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read immutable membership and its complete attributable judgement history.',
    inputSchema: z.object(set).strict(),
    outputSchema: CandidateSetRecordSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'evaluation.candidate-set-select': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Append one human judgement selecting an exact retained member.',
    inputSchema: SelectCandidateSetRequestSchema,
    outputSchema: CandidateSetRecordSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'review.apply',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
