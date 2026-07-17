import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Current Goal Mode plan output schema version. */
export const GOAL_PLAN_OUTPUT_SCHEMA_VERSION = 1;

/** Maximum context budget accepted for one planned worker task. */
export const GOAL_PLAN_TASK_MAX_CONTEXT_TOKENS = 240_000;

/** Resource reference selected by the planner for one task. */
export const GoalPlanTaskResourceSchema = z
  .object({
    kind: z.enum(['repository', 'file', 'item', 'artifact', 'knowledge', 'external']),
    reference: z.string().min(1).max(1_000),
    reason: z.string().min(1).max(1_000),
  })
  .strict();

/** Expected artifact or output from one planned task. */
export const GoalPlanExpectedArtifactSchema = z
  .object({
    kind: z.enum(['code-change', 'test-result', 'document', 'artifact']),
    description: z.string().min(1).max(1_000),
  })
  .strict();

/** Verification check expected after one planned task. */
export const GoalPlanVerificationCheckSchema = z
  .object({
    kind: z.enum(['command', 'test', 'manual']),
    description: z.string().min(1).max(1_000),
    command: z.string().min(1).max(1_000).optional(),
  })
  .strict();

/** Review policy attached to one planned task. */
export const GoalPlanReviewPolicySchema = z
  .object({
    required: z.boolean(),
    reviewers: z.tuple([z.literal('human')]),
    instructions: z.string().min(1).max(2_000),
  })
  .strict();

/** One bounded worker task proposed by Plan Mode. */
export const GoalPlanTaskSchema = z
  .object({
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
  })
  .strict();

/** Bounded Plan Mode output that can be reviewed before worker execution. */
export const GoalPlanOutputSchema = z
  .object({
    schemaVersion: z.literal(GOAL_PLAN_OUTPUT_SCHEMA_VERSION),
    goalSummary: z.string().min(1).max(2_000),
    assumptions: z.array(z.string().min(1).max(1_000)).max(20),
    tasks: z.array(GoalPlanTaskSchema).min(1).max(50),
    risks: z.array(z.string().min(1).max(1_000)).max(20),
    questions: z.array(z.string().min(1).max(1_000)).max(20),
    verificationApproach: z.string().min(1).max(2_000),
  })
  .strict();

/**
 * Computes the canonical digest for one validated Goal Plan payload.
 *
 * @param input Goal Plan payload to validate and digest.
 * @returns Stable SHA-256 digest with the `sha256:` prefix.
 */
export function computeGoalPlanDigest(input: GoalPlanOutput): string {
  const plan = GoalPlanOutputSchema.parse(selectGoalPlanPayload(input));
  return `sha256:${createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')}`;
}

/**
 * Selects the exact seven-field Goal Plan payload from a record carrying separate lineage.
 *
 * @param input Goal Plan payload or immutable Plan record.
 * @returns Exact digest-bearing Goal Plan payload.
 */
export function selectGoalPlanPayload(input: GoalPlanOutput): GoalPlanOutput {
  return {
    schemaVersion: input.schemaVersion,
    goalSummary: input.goalSummary,
    assumptions: input.assumptions,
    tasks: input.tasks,
    risks: input.risks,
    questions: input.questions,
    verificationApproach: input.verificationApproach,
  };
}

/**
 * Validates Goal Plan task identity and dependency graph integrity.
 *
 * @param tasks Ordered Goal Plan tasks.
 * @throws Error when ids are duplicated or dependencies are self-referential, missing, or cyclic.
 */
export function assertValidGoalPlanGraph(tasks: readonly GoalPlanTask[]): void {
  const taskIds = new Set<string>();

  for (const task of tasks) {
    if (taskIds.has(task.taskId)) {
      throw new Error(`Plan task id is duplicated: ${task.taskId}.`);
    }
    taskIds.add(task.taskId);
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependsOnTaskIds) {
      if (dependencyId === task.taskId) {
        throw new Error(`Plan task ${task.taskId} cannot depend on itself.`);
      }
      if (!taskIds.has(dependencyId)) {
        throw new Error(`Plan task ${task.taskId} depends on missing task ${dependencyId}.`);
      }
    }
  }

  const remaining = new Map(
    tasks.map((task) => [task.taskId, new Set(task.dependsOnTaskIds)] as const)
  );
  // ponytail: O(n²) is bounded by the 50-task plan schema; use an indegree queue only if that bound grows.
  while (remaining.size > 0) {
    const readyTaskId = [...remaining].find(([, dependencies]) => dependencies.size === 0)?.[0];
    if (!readyTaskId) {
      throw new Error('Plan task dependencies contain a cycle.');
    }
    remaining.delete(readyTaskId);
    for (const dependencies of remaining.values()) {
      dependencies.delete(readyTaskId);
    }
  }
}

/**
 * Serializes JSON with recursively sorted object keys and preserved array order.
 *
 * @param value JSON-compatible value.
 * @returns Canonical JSON without insignificant whitespace.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

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

/** Verification check expected after one planned task. */
export type GoalPlanVerificationCheck = z.infer<typeof GoalPlanVerificationCheckSchema>;
/** Resource reference selected by the planner for one task. */
export type GoalPlanTaskResource = z.infer<typeof GoalPlanTaskResourceSchema>;
/** Expected artifact or output from one planned task. */
export type GoalPlanExpectedArtifact = z.infer<typeof GoalPlanExpectedArtifactSchema>;
/** Review policy attached to one planned task. */
export type GoalPlanReviewPolicy = z.infer<typeof GoalPlanReviewPolicySchema>;
/** One bounded worker task proposed by Plan Mode. */
export type GoalPlanTask = z.infer<typeof GoalPlanTaskSchema>;
/** Bounded Plan Mode output that can be reviewed before worker execution. */
export type GoalPlanOutput = z.infer<typeof GoalPlanOutputSchema>;
