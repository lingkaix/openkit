import { z } from 'zod';

import {
  AgentIdSchema,
  AgentProfileIdSchema,
  AgentSessionIdSchema,
  ApprovalRequestIdSchema,
  ItemIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserInputRequestIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';
import { ActorRefSchema, responsibleUserIdForActor } from './actor.js';
import { ItemSchema } from './item.js';

/**
 * Closed lifecycle states for a user-visible turn.
 */
export const TurnStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_human',
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
  'ask_user',
  'budget_exhausted',
]);

/**
 * Closed protocol reason explaining why model generation or turn execution stopped.
 */
export type StopReason = z.infer<typeof StopReasonSchema>;

/**
 * Approval gate that pauses a turn until a human grants or denies one request.
 */
export const ApprovalHumanGateSchema = z.object({
  kind: z.literal('approval'),
  approvalRequestId: ApprovalRequestIdSchema,
  itemId: ItemIdSchema,
});

/**
 * User-input gate that pauses a turn until a human answers one agent question.
 */
export const UserInputHumanGateSchema = z.object({
  kind: z.literal('user-input'),
  userInputRequestId: UserInputRequestIdSchema,
  itemId: ItemIdSchema,
});

/**
 * Human gate that explains why a turn is paused in `awaiting_human`.
 */
export const TurnHumanGateSchema = z.discriminatedUnion('kind', [
  ApprovalHumanGateSchema,
  UserInputHumanGateSchema,
]);

/**
 * Human gate that explains why a turn is paused in `awaiting_human`.
 */
export type TurnHumanGate = z.infer<typeof TurnHumanGateSchema>;

/**
 * Error payload attached to failed turns.
 */
export const TurnErrorSchema = z.object({
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
  triggerSource: TurnTriggerSourceSchema.nullable().optional(),
  configVersion: z.number().int().positive().nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

/**
 * Creates one non-human-gated turn status variant.
 *
 * @param status Turn status that cannot carry a human gate.
 * @returns Turn schema variant for that status.
 */
function nonHumanGatedTurnSchema(status: Exclude<TurnStatus, 'awaiting_human'>) {
  return TurnBaseSchema.extend({
    status: z.literal(status),
    humanGate: z.null(),
  });
}

const TurnUnionSchema = z.union([
  nonHumanGatedTurnSchema('pending'),
  nonHumanGatedTurnSchema('running'),
  TurnBaseSchema.extend({
    status: z.literal('awaiting_human'),
    humanGate: TurnHumanGateSchema,
  }),
  nonHumanGatedTurnSchema('completed'),
  nonHumanGatedTurnSchema('interrupted'),
  nonHumanGatedTurnSchema('cancelled'),
  nonHumanGatedTurnSchema('failed'),
]);

/**
 * Enforces user-input request/response ownership inside one Turn.
 *
 * @param turn Parsed Turn variant.
 * @param context Zod refinement context.
 */
function refineTurnItemRelationships(
  turn: z.infer<typeof TurnUnionSchema>,
  context: z.RefinementCtx
): void {
  const responsibleUserId = responsibleUserIdForActor(turn.triggerActor);

  for (const [index, item] of turn.items.entries()) {
    if (item.type === 'user-input-response') {
      const matchingRequests = turn.items
        .filter((candidate) => candidate.type === 'user-input-request')
        .filter((candidate) => candidate.userInputRequestId === item.userInputRequestId);

      if (matchingRequests.length !== 1) {
        context.addIssue({
          code: 'custom',
          message: 'User-input response must match exactly one request in the same Turn.',
          path: ['items', index, 'userInputRequestId'],
        });
      } else if (item.actor.id !== matchingRequests[0]!.responsibleUserId) {
        context.addIssue({
          code: 'custom',
          message: 'User-input response actor must match the request responsible user.',
          path: ['items', index, 'actor', 'id'],
        });
      }
    }

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
export const TurnSchema = TurnUnionSchema.superRefine(refineTurnItemRelationships);

/**
 * Ordinary product-surface Turn projection that omits hidden AgentSession identity.
 */
export const ProductTurnSchema = z
  .union(TurnUnionSchema.options.map((variant) => variant.omit({ agentSessionId: true })))
  .superRefine(refineTurnItemRelationships);

/** Ordinary product-surface Turn without AgentSession identity. */
export type ProductTurn = z.infer<typeof ProductTurnSchema>;
