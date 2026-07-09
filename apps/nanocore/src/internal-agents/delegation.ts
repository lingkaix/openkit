import { z } from 'zod';

import { WORKER_COORDINATOR_AGENT_ID } from './tools.js';
import type {
  WorkerCoordinatorDecision,
  WorkerCoordinatorDecisionKind,
  WorkerCoordinatorRuntime,
} from './worker-coordinator.js';

export const WORKER_DELEGATION_DRAFT_SCHEMA_VERSION = 1;
export const STRUCTURED_WORKER_DELEGATION_REQUEST_SCHEMA_VERSION = 1;
export const WORKER_ROUTING_SUMMARY_SCHEMA_VERSION = 1;
export const TASK_EVALUATION_NOTE_SCHEMA_VERSION = 1;
export const STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS = 240_000;
export const SUSTAINED_MODE_SOURCE_SPEC =
  'docs/specs/20260525-sustained_mode_long_running_agent.md';
export const DELEGATION_COMPOSITION_PHASES = [
  'planning',
  'worker_execution',
  'review',
  'handoff',
  'knowledge_proposal',
  'progress_tracking',
] as const;

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
  mode: z.enum(['automation', 'delegation']),
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
  /** Product mode that produced the draft. */
  readonly mode?: 'automation' | 'delegation';
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
 * App-level routing decision record kind.
 */
export type WorkerRoutingDecisionRecordKind = 'read_model' | 'item';

/**
 * Read-model or item-backed summary of a WorkerCoordinatorAgent decision.
 */
export const WorkerRoutingDecisionSummarySchema = z.object({
  schemaVersion: z.literal(WORKER_ROUTING_SUMMARY_SCHEMA_VERSION),
  recordKind: z.enum(['read_model', 'item']),
  sourceAgentId: z.literal(WORKER_COORDINATOR_AGENT_ID),
  decision: z.enum([
    'quick_chat',
    'worker_turn',
    'goal',
    'clarify',
    'review',
    'refinement',
    'retry',
    'handoff',
    'unsupported',
    'blocked',
  ]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  selectedAgentId: z.string().nullable(),
  requiredUserAction: z.string().nullable(),
  delegationDraft: WorkerDelegationDraftSchema.nullable(),
});

/**
 * Summary of one WorkerCoordinatorAgent decision suitable for read models or item records.
 */
export type WorkerRoutingDecisionSummary = z.infer<typeof WorkerRoutingDecisionSummarySchema>;

/**
 * Product-facing delegation preparation snapshot.
 */
export const DelegationPreparationSnapshotSchema = z.object({
  mode: z.literal('delegation'),
  fullLoopEnabled: z.literal(false),
  sourceSpec: z.literal(SUSTAINED_MODE_SOURCE_SPEC),
  compositionPhases: z.tuple([
    z.literal('planning'),
    z.literal('worker_execution'),
    z.literal('review'),
    z.literal('handoff'),
    z.literal('knowledge_proposal'),
    z.literal('progress_tracking'),
  ]),
  routingSummary: WorkerRoutingDecisionSummarySchema,
});

/**
 * Product-facing snapshot that prepares future delegation without running the full loop.
 */
export type DelegationPreparationSnapshot = z.infer<typeof DelegationPreparationSnapshotSchema>;

/**
 * Reserved task evaluation note shape for later review-mode work.
 */
export const TaskEvaluationNoteSchema = z.object({
  schemaVersion: z.literal(TASK_EVALUATION_NOTE_SCHEMA_VERSION),
  sourceAgentId: z.literal('task-evaluator'),
  status: z.literal('reserved'),
  outcome: z.enum(['accept', 'revise', 'retry', 'handoff', 'escalate']),
  summary: z.string().min(1),
  evidenceRefs: z.array(ContextRefSchema),
  recommendedNextAction: z.string().min(1),
});

/**
 * Reserved task evaluation note for future TaskEvaluatorAgent output.
 */
export type TaskEvaluationNote = z.infer<typeof TaskEvaluationNoteSchema>;

/**
 * Input for a reserved task evaluation note.
 */
export interface TaskEvaluationNoteInput {
  /** Evaluation outcome. */
  readonly outcome?: TaskEvaluationNote['outcome'];
  /** Human-readable evaluation summary. */
  readonly summary: string;
  /** Source references used by the evaluator. */
  readonly evidenceRefs: readonly DelegationContextRef[];
  /** Recommended next action for Core or the user. */
  readonly recommendedNextAction: string;
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
    mode: input.mode ?? 'automation',
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

/**
 * Converts a WorkerCoordinatorAgent decision to a stable record-ready summary.
 *
 * @param decision WorkerCoordinatorAgent decision.
 * @param recordKind Storage projection kind for the summary.
 * @returns Worker routing decision summary.
 */
export function createWorkerRoutingDecisionSummary(
  decision: WorkerCoordinatorDecision,
  recordKind: WorkerRoutingDecisionRecordKind
): WorkerRoutingDecisionSummary {
  return WorkerRoutingDecisionSummarySchema.parse({
    schemaVersion: WORKER_ROUTING_SUMMARY_SCHEMA_VERSION,
    recordKind,
    sourceAgentId: WORKER_COORDINATOR_AGENT_ID,
    decision: normalizeRoutingDecision(decision.decision),
    confidence: decision.confidence,
    explanation: decision.explanation,
    selectedAgentId: decision.selectedWorkerCandidate?.agentId ?? null,
    requiredUserAction: decision.requiredUserAction === 'none' ? null : decision.requiredUserAction,
    delegationDraft: decision.delegationDraft,
  });
}

/**
 * Creates a delegation preparation snapshot without enabling the sustained loop.
 *
 * @param decision WorkerCoordinatorAgent decision to summarize.
 * @returns Delegation preparation snapshot.
 */
export function createDelegationPreparationSnapshot(
  decision: WorkerCoordinatorDecision
): DelegationPreparationSnapshot {
  return DelegationPreparationSnapshotSchema.parse({
    mode: 'delegation',
    fullLoopEnabled: false,
    sourceSpec: SUSTAINED_MODE_SOURCE_SPEC,
    compositionPhases: DELEGATION_COMPOSITION_PHASES,
    routingSummary: createWorkerRoutingDecisionSummary(decision, 'read_model'),
  });
}

/**
 * Creates a reserved task evaluation note for future review-mode implementation.
 *
 * @param input Evaluation note input.
 * @returns Reserved task evaluation note.
 */
export function createTaskEvaluationNote(input: TaskEvaluationNoteInput): TaskEvaluationNote {
  return TaskEvaluationNoteSchema.parse({
    schemaVersion: TASK_EVALUATION_NOTE_SCHEMA_VERSION,
    sourceAgentId: 'task-evaluator',
    status: 'reserved',
    outcome: input.outcome ?? 'revise',
    summary: input.summary,
    evidenceRefs: input.evidenceRefs,
    recommendedNextAction: input.recommendedNextAction,
  });
}

/**
 * Normalizes routing decisions to the record-supported decision set.
 *
 * @param decision Worker coordinator decision.
 * @returns Record-supported decision label.
 */
function normalizeRoutingDecision(
  decision: WorkerCoordinatorDecisionKind
): WorkerRoutingDecisionSummary['decision'] {
  return decision;
}
