import { ExecutionAttemptIdSchema, TurnIdSchema, WorkOwnerSchema } from '@openkit/protocol';
import { z } from 'zod';

const boundedReference = z.string().min(1).max(512);
const inputDigest = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceDigest = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const kernelExecutionRef = z.strictObject({
  owner: WorkOwnerSchema,
  executionId: boundedReference,
});
const kernelExecutionStepRef = z.strictObject({
  execution: kernelExecutionRef,
  stepId: boundedReference,
});
const grantCoordinates = z.strictObject({
  attemptId: ExecutionAttemptIdSchema,
  backendId: boundedReference,
  bindingRef: boundedReference.nullable(),
  inputRef: boundedReference.nullable(),
  operationId: boundedReference,
  execution: kernelExecutionRef,
  turnId: TurnIdSchema,
  generation: boundedReference,
});

/** Original preparation and submitted grants have distinct closed clock facts. */
export const KernelExecutionGrantSchema = z.union([
  grantCoordinates.extend({
    deadline: z.null(),
    preparationStep: kernelExecutionStepRef,
  }),
  grantCoordinates.extend({ deadline: z.iso.datetime() }),
]);

export const KernelGrantStepSchema = z.strictObject({
  version: z.literal(1),
  grant: KernelExecutionGrantSchema,
  requestDigest: evidenceDigest,
  submission: z.boolean(),
});

export type KernelExecutionGrant = z.infer<typeof KernelGrantStepSchema>;

/** A local reference to exact original content, never the bytes themselves. */
export const SelectedKernelInputSchema = z.strictObject({
  input: z.strictObject({
    owner: WorkOwnerSchema,
    inputId: boundedReference,
    digest: inputDigest,
  }),
  order: z.number().int().nonnegative(),
  originalInvocationId: boundedReference,
  grant: KernelExecutionGrantSchema,
});

const inputObservationCoordinates = {
  obligation: kernelExecutionStepRef,
  selected: SelectedKernelInputSchema,
  boundary: boundedReference,
};
const boundedEvidence = {
  ref: boundedReference,
  digest: evidenceDigest,
};
const inputEvidence = z.union([
  z.strictObject({ ...boundedEvidence, backendId: boundedReference }),
  z.strictObject({ ...boundedEvidence, owner: WorkOwnerSchema }),
]);

/** A1 r2 exact linked findings, including honest unknown and non-submission. */
export const KernelInputProofSchema = z.union([
  z.strictObject({
    ...inputObservationCoordinates,
    kind: z.literal('intake'),
    finding: z.enum(['accepted', 'consumed']),
    evidence: inputEvidence,
  }),
  z.strictObject({
    ...inputObservationCoordinates,
    kind: z.literal('intake'),
    finding: z.literal('unknown'),
    evidence: inputEvidence.nullable(),
  }),
  z.strictObject({
    ...inputObservationCoordinates,
    kind: z.literal('non-submission'),
    reason: z.enum(['refused-before-contact', 'removed-before-processing']),
    evidence: inputEvidence,
  }),
]);

export const KernelExecutionProofIntentSchema = z.strictObject({
  deploymentId: boundedReference,
  sourceOwner: boundedReference,
  verb: z.literal('apply-execution-proof'),
  occurrenceKey: boundedReference,
  requestId: z.uuid(),
  target: KernelExecutionGrantSchema,
  expectedGeneration: boundedReference.nullable(),
  inputDigest: evidenceDigest,
});

/** The existing invocation JSON carries the immutable obligation or its linked outcome. */
export const KernelInputStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('input-obligation'),
    selected: SelectedKernelInputSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('input-proof'),
    intent: KernelExecutionProofIntentSchema,
    proof: KernelInputProofSchema,
  }),
]);

export type KernelInputStep = z.infer<typeof KernelInputStepSchema>;

export const KernelFenceProofSchema = z.strictObject({
  kind: z.literal('fence'),
  fence: z.strictObject({ ...boundedEvidence, backendId: boundedReference }),
  coveredScopeRefs: z.array(boundedReference).min(1).max(256),
});

export const KernelSubmissionProofSchema = z.union([
  z.strictObject({
    kind: z.literal('submission'),
    disposition: z.enum(['accepted', 'not_accepted']),
    evidence: z.strictObject({ ...boundedEvidence, backendId: boundedReference }),
  }),
  z.strictObject({
    kind: z.literal('submission'),
    disposition: z.literal('unknown'),
    evidence: z.strictObject({ ...boundedEvidence, backendId: boundedReference }).nullable(),
  }),
]);

export const KernelHandoffSchema = z.strictObject({
  ...boundedEvidence,
  owner: WorkOwnerSchema,
  kind: z.enum(['terminal-publication', 'output', 'evidence', 'outside-workspace-collection']),
});

/** Submission, fence and handoff facts remain independent on the original execution. */
export const KernelExecutionEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('submission'),
    intent: KernelExecutionProofIntentSchema,
    proof: KernelSubmissionProofSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('fence'),
    intent: KernelExecutionProofIntentSchema,
    proof: KernelFenceProofSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('handoff'),
    intent: KernelExecutionProofIntentSchema,
    handoff: KernelHandoffSchema,
  }),
]);

export type KernelExecutionEvidence = z.infer<typeof KernelExecutionEvidenceSchema>;
