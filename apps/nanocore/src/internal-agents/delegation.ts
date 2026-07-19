import { z } from 'zod';

import {
  GoalPlanExpectedArtifactSchema,
  GoalPlanReviewPolicySchema,
  GoalPlanTaskResourceSchema,
  GoalPlanVerificationCheckSchema,
} from '../runtime/goal-plan.js';

/** Stable attribution id for deterministic worker coordination decisions. */
export const WORKER_COORDINATOR_AGENT_ID = 'worker-coordinator';

export const WORKER_DELEGATION_DRAFT_SCHEMA_VERSION = 1;
export const STRUCTURED_WORKER_DELEGATION_REQUEST_SCHEMA_VERSION = 1;
export const STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS = 240_000;

const ContextRefSchema = z
  .object({
    kind: z.enum(['workspace', 'thread', 'artifact', 'knowledge', 'item']),
    id: z.string().min(1),
  })
  .strict();
const WorkerDelegationTargetSchema = z
  .object({
    agentId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();
const WorkerDelegationConstraintsSchema = z
  .object({
    maxWorkerIterations: z.literal(1),
  })
  .strict();
const StructuredWorkerDelegationConstraintsSchema = z
  .object({
    maxContextTokens: z
      .number()
      .int()
      .positive()
      .max(STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS),
    maxWorkerIterations: z.literal(1),
  })
  .strict();
const StructuredWorkerDelegationReviewEvidenceSchema = z
  .object({
    itemIds: z.array(z.string().min(1)).max(100),
    artifactIds: z.array(z.string().min(1)).max(100),
  })
  .strict();
const StructuredWorkerDelegationReviewContextSchema = z.discriminatedUnion('verdict', [
  z
    .object({
      reviewId: z.string().min(1),
      verdict: z.literal('refine'),
      reason: z.string().min(1).nullable(),
      revisionInstruction: z.string().min(1),
      priorTurnId: z.string().min(1),
      evidence: StructuredWorkerDelegationReviewEvidenceSchema,
    })
    .strict(),
  z
    .object({
      reviewId: z.string().min(1),
      verdict: z.literal('retry'),
      reason: z.string().min(1),
      revisionInstruction: z.null(),
      priorTurnId: z.string().min(1),
      evidence: StructuredWorkerDelegationReviewEvidenceSchema,
    })
    .strict(),
]);

/**
 * Source reference used by delegation preparation records.
 */
export type DelegationContextRef = z.infer<typeof ContextRefSchema>;

/**
 * Structured worker delegation request for bounded worker execution.
 */
export const StructuredWorkerDelegationRequestSchema = z
  .object({
    schemaVersion: z.literal(STRUCTURED_WORKER_DELEGATION_REQUEST_SCHEMA_VERSION),
    objective: z.string().min(1).max(2_000),
    acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
    contextRefs: z.array(ContextRefSchema).min(1).max(50),
    resources: z.array(GoalPlanTaskResourceSchema).max(50),
    expectedArtifacts: z.array(GoalPlanExpectedArtifactSchema).max(20),
    constraints: StructuredWorkerDelegationConstraintsSchema,
    verification: z.array(GoalPlanVerificationCheckSchema).min(1).max(20),
    reviewPolicy: GoalPlanReviewPolicySchema,
    escalationConditions: z.array(z.string().min(1).max(1_000)).max(20),
    reviewContext: StructuredWorkerDelegationReviewContextSchema.nullable(),
  })
  .strict();

/**
 * App-local structured worker delegation request.
 */
export type StructuredWorkerDelegationRequest = z.infer<
  typeof StructuredWorkerDelegationRequestSchema
>;

/**
 * Input used to create a structured worker delegation request.
 */
export interface StructuredWorkerDelegationRequestInput {
  /** Concise worker objective. */
  readonly objective: string;
  /** Measurable acceptance criteria for the worker task. */
  readonly acceptanceCriteria: readonly string[];
  /** Source context references selected for the worker. */
  readonly contextRefs: readonly DelegationContextRef[];
  /** Exact semantic resources selected for the worker task. */
  readonly resources: readonly z.input<typeof GoalPlanTaskResourceSchema>[];
  /** Expected artifacts or file changes from the worker task. */
  readonly expectedArtifacts: readonly z.input<typeof GoalPlanExpectedArtifactSchema>[];
  /** Execution constraints for the bounded worker task. */
  readonly constraints: z.input<typeof StructuredWorkerDelegationConstraintsSchema>;
  /** Verification commands or checks expected after worker execution. */
  readonly verification: readonly z.input<typeof GoalPlanVerificationCheckSchema>[];
  /** Review policy for the worker output. */
  readonly reviewPolicy: z.input<typeof GoalPlanReviewPolicySchema>;
  /** Conditions that require the worker to escalate instead of inventing scope. */
  readonly escalationConditions: readonly string[];
  /** Resolved Goal Review context for a continuation, or null for an initial attempt. */
  readonly reviewContext: z.input<typeof StructuredWorkerDelegationReviewContextSchema> | null;
}

/**
 * Stable app-level worker delegation draft shape.
 */
export const WorkerDelegationDraftSchema = z
  .object({
    schemaVersion: z.literal(WORKER_DELEGATION_DRAFT_SCHEMA_VERSION),
    source: z.literal(WORKER_COORDINATOR_AGENT_ID),
    mode: z.literal('automation'),
    prompt: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    target: WorkerDelegationTargetSchema,
    constraints: WorkerDelegationConstraintsSchema,
    contextRefs: z.array(ContextRefSchema).min(2),
  })
  .strict();

/**
 * Stable app-level worker delegation draft.
 */
export type WorkerDelegationDraft = z.infer<typeof WorkerDelegationDraftSchema>;

/**
 * Input required to create a worker delegation draft.
 */
export interface WorkerDelegationDraftInput {
  /** User or planner prompt for the worker. */
  readonly prompt: string;
  /** Workspace id for the delegated work. */
  readonly workspaceId: string;
  /** Thread id for the delegated work. */
  readonly threadId: string;
  /** Selected worker target. */
  readonly target: {
    /** Worker agent id. */
    readonly agentId: string;
    /** Human-readable worker display name. */
    readonly displayName: string;
  };
  /** Optional additional source references for the future context package. */
  readonly contextRefs?: readonly DelegationContextRef[];
}

/**
 * Creates a stable worker delegation draft without enabling sustained iteration.
 *
 * @param input Draft source data.
 * @returns Parsed worker delegation draft.
 */
export function createWorkerDelegationDraft(
  input: WorkerDelegationDraftInput
): WorkerDelegationDraft {
  return WorkerDelegationDraftSchema.parse({
    schemaVersion: WORKER_DELEGATION_DRAFT_SCHEMA_VERSION,
    source: WORKER_COORDINATOR_AGENT_ID,
    mode: 'automation',
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    target: {
      agentId: input.target.agentId,
      displayName: input.target.displayName,
    },
    constraints: {
      maxWorkerIterations: 1,
    },
    contextRefs: [
      { kind: 'workspace', id: input.workspaceId },
      { kind: 'thread', id: input.threadId },
      ...(input.contextRefs ?? []),
    ],
  });
}

/**
 * Creates a structured worker delegation request for bounded worker execution.
 *
 * @param input Structured worker request input.
 * @returns Parsed app-local worker delegation request.
 * @throws z.ZodError when required fields are missing, malformed, or oversized.
 */
export function createStructuredWorkerDelegationRequest(
  input: StructuredWorkerDelegationRequestInput
): StructuredWorkerDelegationRequest {
  return StructuredWorkerDelegationRequestSchema.parse({
    schemaVersion: STRUCTURED_WORKER_DELEGATION_REQUEST_SCHEMA_VERSION,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    contextRefs: input.contextRefs,
    resources: input.resources,
    expectedArtifacts: input.expectedArtifacts,
    constraints: input.constraints,
    verification: input.verification,
    reviewPolicy: input.reviewPolicy,
    escalationConditions: input.escalationConditions,
    reviewContext: input.reviewContext,
  });
}

/**
 * Serializes one validated worker request for the existing text Turn boundary.
 *
 * @param request Structured worker request selected for delivery.
 * @returns Compact canonical JSON accepted by text-only worker adapters.
 * @throws z.ZodError when the request does not satisfy the structured contract.
 */
export function serializeStructuredWorkerDelegationRequest(
  request: StructuredWorkerDelegationRequest
): string {
  return JSON.stringify(StructuredWorkerDelegationRequestSchema.parse(request));
}
