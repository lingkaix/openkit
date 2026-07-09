import { z } from 'zod';

/** Current Goal Mode plan output schema version. */
export const GOAL_PLAN_OUTPUT_SCHEMA_VERSION = 1;

/** Maximum context budget accepted for one planned worker task. */
export const GOAL_PLAN_TASK_MAX_CONTEXT_TOKENS = 240_000;

/** Resource reference selected by the planner for one task. */
export const GoalPlanTaskResourceSchema = z.object({
  kind: z.enum(['repository', 'file', 'item', 'artifact', 'knowledge', 'external']),
  reference: z.string().min(1).max(1_000),
  reason: z.string().min(1).max(1_000),
});

/** Expected artifact or output from one planned task. */
export const GoalPlanExpectedArtifactSchema = z.object({
  kind: z.enum(['code-change', 'test-result', 'document', 'artifact']),
  description: z.string().min(1).max(1_000),
});

/** Verification check expected after one planned task. */
export const GoalPlanVerificationCheckSchema = z.object({
  kind: z.enum(['command', 'test', 'manual']),
  description: z.string().min(1).max(1_000),
  command: z.string().min(1).max(1_000).optional(),
});

/** Review policy attached to one planned task. */
export const GoalPlanReviewPolicySchema = z.object({
  required: z.boolean(),
  reviewers: z
    .array(z.enum(['human', 'internal', 'worker']))
    .min(1)
    .max(3),
  instructions: z.string().min(1).max(2_000),
});

/** One bounded worker task proposed by Plan Mode. */
export const GoalPlanTaskSchema = z.object({
  taskId: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(2_000),
  acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
  contextBudgetTokens: z.number().int().positive().max(GOAL_PLAN_TASK_MAX_CONTEXT_TOKENS),
  resources: z.array(GoalPlanTaskResourceSchema).max(50),
  expectedArtifacts: z.array(GoalPlanExpectedArtifactSchema).max(20),
  verificationChecks: z.array(GoalPlanVerificationCheckSchema).min(1).max(20),
  reviewPolicy: GoalPlanReviewPolicySchema,
  dependsOnTaskIds: z.array(z.string().min(1).max(120)).max(20),
  escalationConditions: z.array(z.string().min(1).max(1_000)).max(20),
});

/** Bounded Plan Mode output that can be reviewed before worker execution. */
export const GoalPlanOutputSchema = z.object({
  schemaVersion: z.literal(GOAL_PLAN_OUTPUT_SCHEMA_VERSION),
  goalSummary: z.string().min(1).max(2_000),
  assumptions: z.array(z.string().min(1).max(1_000)).max(20),
  tasks: z.array(GoalPlanTaskSchema).min(1).max(50),
  risks: z.array(z.string().min(1).max(1_000)).max(20),
  questions: z.array(z.string().min(1).max(1_000)).max(20),
  verificationApproach: z.string().min(1).max(2_000),
});

/**
 * Input for deterministic fallback Goal Mode planning.
 */
export interface DeterministicGoalPlanFallbackInput {
  /** Optional human-readable goal title. */
  readonly goalTitle?: string;
  /** User objective that needs a bounded plan. */
  readonly objective: string;
}

/**
 * Creates deterministic test-support plan output without calling an LLM.
 *
 * @param input Goal objective and optional display title.
 * @returns Schema-validated fallback plan output.
 */
export function createDeterministicGoalPlanFallback(
  input: DeterministicGoalPlanFallbackInput
): GoalPlanOutput {
  const objective = truncateForGoalPlan(input.objective.trim(), 2_000);
  const title = truncateForGoalPlan(input.goalTitle?.trim() || 'Complete goal', 200);

  return GoalPlanOutputSchema.parse({
    schemaVersion: GOAL_PLAN_OUTPUT_SCHEMA_VERSION,
    goalSummary: objective,
    assumptions: [
      'Deterministic fallback planner for test support.',
      'The goal can be attempted as one bounded worker task.',
    ],
    tasks: [
      {
        taskId: 'task_1',
        title,
        objective,
        acceptanceCriteria: ['The requested objective is implemented and verified.'],
        contextBudgetTokens: 12_000,
        resources: [
          {
            kind: 'repository',
            reference: 'linked workspace repository',
            reason: 'Default workspace context for the bounded worker task.',
          },
        ],
        expectedArtifacts: [
          {
            kind: 'artifact',
            description: 'Worker result summary and implementation evidence.',
          },
        ],
        verificationChecks: [
          {
            kind: 'manual',
            description: 'Review the worker output and confirm the objective is satisfied.',
          },
        ],
        reviewPolicy: {
          required: true,
          reviewers: ['human'],
          instructions: 'Review deterministic fallback output before continuing Goal Mode.',
        },
        dependsOnTaskIds: [],
        escalationConditions: [
          'Escalate if the objective needs decomposition into multiple tasks.',
        ],
      },
    ],
    risks: [
      'Deterministic fallback output is intentionally generic and may need human refinement.',
    ],
    questions: [],
    verificationApproach:
      'Use manual review for fallback-generated plans before worker execution begins.',
  });
}

/**
 * Truncates deterministic fallback text to one schema field limit.
 *
 * @param value Text to fit inside a schema field.
 * @param maxLength Inclusive maximum string length.
 * @returns Original text when it fits, otherwise a trimmed string ending with an ellipsis marker.
 */
function truncateForGoalPlan(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

/** Resource reference selected by the planner for one task. */
export type GoalPlanTaskResource = z.infer<typeof GoalPlanTaskResourceSchema>;
/** Expected artifact or output from one planned task. */
export type GoalPlanExpectedArtifact = z.infer<typeof GoalPlanExpectedArtifactSchema>;
/** Verification check expected after one planned task. */
export type GoalPlanVerificationCheck = z.infer<typeof GoalPlanVerificationCheckSchema>;
/** Review policy attached to one planned task. */
export type GoalPlanReviewPolicy = z.infer<typeof GoalPlanReviewPolicySchema>;
/** One bounded worker task proposed by Plan Mode. */
export type GoalPlanTask = z.infer<typeof GoalPlanTaskSchema>;
/** Bounded Plan Mode output that can be reviewed before worker execution. */
export type GoalPlanOutput = z.infer<typeof GoalPlanOutputSchema>;
