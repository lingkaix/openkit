import { z } from 'zod';

import { WORKER_COORDINATOR_AGENT_ID } from './tools.js';
import type { WorkerCoordinatorRuntime } from './worker-coordinator.js';

export const WORKER_DELEGATION_DRAFT_SCHEMA_VERSION = 1;
export const STRUCTURED_WORKER_DELEGATION_REQUEST_SCHEMA_VERSION = 1;
export const STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS = 240_000;

const ContextRefSchema = z.object({
  kind: z.enum(['workspace', 'thread', 'artifact', 'knowledge', 'item']),
  id: z.string().min(1),
});
const WorkerDelegationTargetSchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  runtime: z.enum(['codex', 'opencode']),
});
const WorkerDelegationConstraintsSchema = z.object({
  maxWorkerIterations: z.literal(1),
  requiresUserConfirmation: z.literal(true),
});
const StructuredWorkerDelegationExpectedArtifactSchema = z.object({
  kind: z.enum(['code-change', 'test-result', 'document', 'artifact']),
  description: z.string().min(1).max(1_000),
});
const StructuredWorkerDelegationConstraintsSchema = z.object({
  maxContextTokens: z
    .number()
    .int()
    .positive()
    .max(STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS),
  maxWorkerIterations: z.number().int().positive().max(5),
  requiresUserConfirmation: z.boolean(),
  stopConditions: z.array(z.string().min(1).max(500)).max(12),
});
const StructuredWorkerDelegationVerificationSchema = z.object({
  kind: z.enum(['command', 'test', 'manual']),
  description: z.string().min(1).max(1_000),
  command: z.string().min(1).max(1_000).optional(),
});
const StructuredWorkerDelegationReviewPolicySchema = z.object({
  required: z.boolean(),
  reviewers: z
    .array(z.enum(['human', 'internal', 'worker']))
    .min(1)
    .max(3),
  instructions: z.string().min(1).max(2_000),
});

/**
 * Source reference used by delegation preparation records.
 */
export type DelegationContextRef = z.infer<typeof ContextRefSchema>;

/**
 * Structured worker delegation request for bounded worker execution.
 */
export const StructuredWorkerDelegationRequestSchema = z.object({
  schemaVersion: z.literal(STRUCTURED_WORKER_DELEGATION_REQUEST_SCHEMA_VERSION),
  objective: z.string().min(1).max(2_000),
  acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
  contextRefs: z.array(ContextRefSchema).min(1).max(50),
  expectedArtifacts: z.array(StructuredWorkerDelegationExpectedArtifactSchema).max(20),
  constraints: StructuredWorkerDelegationConstraintsSchema,
  verification: z.array(StructuredWorkerDelegationVerificationSchema).min(1).max(20),
  reviewPolicy: StructuredWorkerDelegationReviewPolicySchema,
});

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
  /** Expected artifacts or file changes from the worker task. */
  readonly expectedArtifacts: readonly z.input<
    typeof StructuredWorkerDelegationExpectedArtifactSchema
  >[];
  /** Execution constraints for the bounded worker task. */
  readonly constraints: z.input<typeof StructuredWorkerDelegationConstraintsSchema>;
  /** Verification commands or checks expected after worker execution. */
  readonly verification: readonly z.input<typeof StructuredWorkerDelegationVerificationSchema>[];
  /** Review policy for the worker output. */
  readonly reviewPolicy: z.input<typeof StructuredWorkerDelegationReviewPolicySchema>;
}

/**
 * Stable app-level worker delegation draft shape.
 */
export const WorkerDelegationDraftSchema = z.object({
  schemaVersion: z.literal(WORKER_DELEGATION_DRAFT_SCHEMA_VERSION),
  source: z.literal(WORKER_COORDINATOR_AGENT_ID),
  mode: z.literal('automation'),
  prompt: z.string().min(1),
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  target: WorkerDelegationTargetSchema,
  constraints: WorkerDelegationConstraintsSchema,
  contextRefs: z.array(ContextRefSchema).min(2),
});

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
    /** Worker runtime family. */
    readonly runtime: WorkerCoordinatorRuntime;
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
    target: input.target,
    constraints: {
      maxWorkerIterations: 1,
      requiresUserConfirmation: true,
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
    expectedArtifacts: input.expectedArtifacts,
    constraints: input.constraints,
    verification: input.verification,
    reviewPolicy: input.reviewPolicy,
  });
}
