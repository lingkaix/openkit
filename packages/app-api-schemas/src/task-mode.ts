import { TurnSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Request body for starting one bounded Task Mode worker delegation. */
export const StartTaskModeRequestSchema = z.object({
  input: z.string().min(1),
  modelId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
});

/** Worker runtime family selected by the Workflow Coordinator. */
export const TaskModeWorkerRuntimeSchema = z.enum(['codex', 'opencode']);

/** Product-visible Task Mode worker target. */
export const TaskModeWorkerTargetSchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  runtime: TaskModeWorkerRuntimeSchema,
});

/** Task Mode attempt state projected from the accepted worker turn. */
export const TaskModeAttemptStateSchema = z.enum([
  'running',
  'completed',
  'needs-review',
  'awaiting-human',
  'blocked',
  'failed',
  'escalated-to-goal',
]);

/** Source context reference selected by Workflow Coordinator for a Task Mode worker. */
export const TaskModeContextRefSchema = z.object({
  kind: z.enum(['workspace', 'thread', 'artifact', 'knowledge', 'item']),
  id: z.string().min(1),
});

/** Workflow Coordinator decision used to launch one bounded worker attempt. */
export const TaskDelegationDecisionSchema = z.object({
  mode: z.enum(['task', 'goal']),
  sourceAgentId: z.literal('worker-coordinator'),
  worker: TaskModeWorkerTargetSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  requiredApprovals: z.array(z.string().min(1)),
  expectedStopCondition: z.string().min(1),
  escalationRecommended: z.boolean(),
  contextRefs: z.array(TaskModeContextRefSchema).min(1).max(50),
});

/** Task Mode projection when a bounded request is promoted to Goal Mode. */
export const TaskModeGoalEscalationSchema = z.object({
  targetMode: z.literal('goal'),
  goalId: z.string().min(1),
  reason: z.string().min(1),
});

/** Final assistant item projected from a completed Task Mode worker attempt. */
export const TaskModeCompletionSchema = z.object({
  itemId: z.string().min(1),
  text: z.string(),
});

/** Existing thread and artifact records that evidence a Task Mode attempt. */
export const TaskModeEvidenceSchema = z.object({
  itemIds: z.array(z.string().min(1)).max(100),
  artifactIds: z.array(z.string().min(1)).max(100),
  reviewIds: z.array(z.string().min(1)).max(100).default([]),
});

/** Response returned after Task Mode accepts one bounded worker attempt. */
export const StartTaskModeResponseSchema = z.object({
  decision: TaskDelegationDecisionSchema.nullable(),
  turn: TurnSchema,
  state: TaskModeAttemptStateSchema,
  completion: TaskModeCompletionSchema.nullable().optional(),
  evidence: TaskModeEvidenceSchema,
  escalation: TaskModeGoalEscalationSchema.nullable().optional(),
});

/** Request body for starting one bounded Task Mode worker delegation. */
export type StartTaskModeRequest = z.infer<typeof StartTaskModeRequestSchema>;
/** Response returned after Task Mode accepts one bounded worker attempt. */
export type StartTaskModeResponse = z.infer<typeof StartTaskModeResponseSchema>;
/** Workflow Coordinator decision used to launch one Task Mode worker attempt. */
export type TaskDelegationDecision = z.infer<typeof TaskDelegationDecisionSchema>;
/** Source context reference selected by Workflow Coordinator for a Task Mode worker. */
export type TaskModeContextRef = z.infer<typeof TaskModeContextRefSchema>;
/** Task Mode projection when a bounded request is promoted to Goal Mode. */
export type TaskModeGoalEscalation = z.infer<typeof TaskModeGoalEscalationSchema>;
/** Final assistant item projected from a completed Task Mode worker attempt. */
export type TaskModeCompletion = z.infer<typeof TaskModeCompletionSchema>;
/** Existing thread and artifact records that evidence a Task Mode attempt. */
export type TaskModeEvidence = z.infer<typeof TaskModeEvidenceSchema>;
