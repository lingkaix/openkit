import { z } from 'zod';

import {
  AgentIdSchema,
  AgentProfileIdSchema,
  AgentSessionIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { ReasoningEffortSchema } from '../common/reasoning-effort.js';
import { TimestampSchema } from '../common/timestamps.js';
import { GitFailureExplanationSchema } from '../errors/failure-explanation.js';
import { ActorRefSchema, responsibleUserIdForActor } from './actor.js';
import { ItemSchema } from './item.js';

/**
 * Closed lifecycle states for a user-visible turn.
 */
export const TurnStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'interrupted',
  'cancelled',
  'failed',
]);

/**
 * Closed lifecycle state for a user-visible turn.
 */
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

/**
 * Closed protocol reasons explaining why model generation or turn execution stopped.
 */
export const StopReasonSchema = z.enum([
  'completed',
  'error',
  'aborted',
  'length',
  'budget_exhausted',
]);

/**
 * Closed protocol reason explaining why model generation or turn execution stopped.
 */
export type StopReason = z.infer<typeof StopReasonSchema>;

/**
 * Error payload attached to failed turns.
 */
export const TurnErrorSchema = z.object({
  explanation: GitFailureExplanationSchema.optional(),
  code: z.string().min(1).nullable(),
  message: z.string().min(1),
});

/**
 * Bounded reason why a turn was started or resumed.
 */
export const TurnTriggerSourceSchema = z.object({
  kind: z.enum([
    'user-input',
    'system-input',
    'automation',
    'retry',
    'handoff',
    'approval-resolution',
    'running-work-steering',
  ]),
  summary: z.string().min(1).nullable(),
});

/**
 * Shared fields for every user-visible turn status variant.
 */
const TurnBaseSchema = z.object({
  id: TurnIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  triggerActor: ActorRefSchema,
  items: z.array(ItemSchema),
  error: TurnErrorSchema.nullable(),
  agentSessionId: AgentSessionIdSchema.nullable().optional(),
  agentId: AgentIdSchema.nullable().optional(),
  agentProfileId: AgentProfileIdSchema.nullable().optional(),
  /** Immutable admission preference; absence records no choice. */
  reasoningEffort: ReasoningEffortSchema.optional(),
  triggerSource: TurnTriggerSourceSchema.nullable().optional(),
  configVersion: z.number().int().positive().nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

/** Turn record before item-relationship refinement. */
export const TurnRecordSchema = TurnBaseSchema.extend({
  status: TurnStatusSchema,
});

/**
 * Enforces user-input request attribution on the Turn that carries the request Item.
 * A response may name its request anywhere in the same Thread. That check belongs to the pending-request owner.
 *
 * @param turn Parsed Turn.
 * @param context Zod refinement context.
 */
function refineTurnItemRelationships(
  turn: z.infer<typeof TurnRecordSchema>,
  context: z.RefinementCtx
): void {
  const responsibleUserId = responsibleUserIdForActor(turn.triggerActor);

  for (const [index, item] of turn.items.entries()) {
    if (item.type !== 'user-input-request') {
      continue;
    }

    if (item.responsibleUserId !== responsibleUserId) {
      context.addIssue({
        code: 'custom',
        message: 'User-input request responsible user must match the turn trigger actor.',
        path: ['items', index, 'responsibleUserId'],
      });
    }
  }
}

/**
 * An attributable round of work within a thread.
 */
export const TurnSchema = TurnRecordSchema.superRefine(refineTurnItemRelationships);

/**
 * Ordinary product-surface Turn projection that omits hidden AgentSession identity.
 */
export const ProductTurnSchema = TurnRecordSchema.omit({ agentSessionId: true }).superRefine(
  refineTurnItemRelationships
);

/** Ordinary product-surface Turn without AgentSession identity. */
export type ProductTurn = z.infer<typeof ProductTurnSchema>;
