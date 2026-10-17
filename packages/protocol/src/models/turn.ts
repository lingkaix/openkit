import { z } from 'zod';

import {
  AgentIdSchema,
  AgentProfileIdSchema,
  AgentSessionIdSchema,
  CapabilityCallIdSchema,
  ItemIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { ReasoningEffortSchema } from '../common/reasoning-effort.js';
import { TimestampSchema } from '../common/timestamps.js';
import { GitFailureExplanationSchema } from '../errors/failure-explanation.js';
import { ActorRefSchema, responsibleUserIdForActor } from './actor.js';
import { ArtifactMediaTypeSchema, MAX_ARTIFACT_FILE_BYTES } from './artifact.js';
import { ItemSchema } from './item.js';
import { KnowledgeOwnerScopeSchema } from './knowledge-notebook.js';

/** Pinned choices and admitted inputs of an existing internal-role Turn, never an execution store. */
const InternalAgentExecutionSchema = z.object({
  roleId: z.string().min(1),
  logicalModelId: z.string().min(1),
  contextStrategy: z.enum(['rolling', 'compaction']),
  threshold: z.number().int().positive(),
  knowledge: z
    .object({
      purpose: z.enum(['query', 'maintenance']),
      ownerScope: KnowledgeOwnerScopeSchema,
      baseRevision: z.string().min(1),
      trigger: z.enum(['schedule', 'request']),
      instructions: z.string().min(1),
      sourceRange: z.array(
        z.object({
          threadId: ThreadIdSchema,
          turnId: TurnIdSchema,
          firstItemId: ItemIdSchema,
          lastItemId: ItemIdSchema,
        })
      ),
      askingThreadId: ThreadIdSchema.optional(),
      askingTurnId: TurnIdSchema.optional(),
      askingCapabilityCallId: CapabilityCallIdSchema.optional(),
    })
    .optional(),
});

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

/** One exact Turn-owned original. Array position is its immutable ordinal; names are display data, never paths. */
export const TurnFileInputSchema = z.object({
  name: z.string().min(1).max(1024),
  mediaType: ArtifactMediaTypeSchema,
  sizeBytes: z.number().int().min(0).max(MAX_ARTIFACT_FILE_BYTES),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

/** Ordered input metadata has a bounded inventory and shares one decimal billion-byte submission allowance. */
export const TurnFileInputsSchema = z
  .array(TurnFileInputSchema)
  .max(10_000)
  .superRefine((inputs, context) => {
    if (inputs.reduce((total, input) => total + input.sizeBytes, 0) > MAX_ARTIFACT_FILE_BYTES)
      context.addIssue({
        code: 'custom',
        message: 'Conversation files exceed the combined byte limit.',
      });
  });

/** Exact immutable file identity under the receiving Turn's audience and retention. */
export type TurnFileInput = z.infer<typeof TurnFileInputSchema>;

/** Exact run choices for already-included Skills; these are work input, not catalog mutations. */
export const TurnSkillSelectionsSchema = z
  .array(
    z
      .object({
        skillId: z.string().min(1),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
  )
  .superRefine((selections, context) => {
    const ids = new Set<string>();
    for (const [index, selection] of selections.entries()) {
      if (ids.has(selection.skillId))
        context.addIssue({
          code: 'custom',
          message: 'Run Skill selections must have unique Skill ids.',
          path: [index, 'skillId'],
        });
      ids.add(selection.skillId);
    }
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
  /** Optional retained absence is an empty inventory; original bytes stay outside this record. */
  fileInputs: TurnFileInputsSchema.optional(),
  error: TurnErrorSchema.nullable(),
  agentSessionId: AgentSessionIdSchema.nullable().optional(),
  agentId: AgentIdSchema.nullable().optional(),
  agentProfileId: AgentProfileIdSchema.nullable().optional(),
  /** Immutable admission preference; absence records no choice. */
  reasoningEffort: ReasoningEffortSchema.optional(),
  /** Exact explicit Skill versions retained at admission; absence records ordinary resolution. */
  skillSelections: TurnSkillSelectionsSchema.optional(),
  triggerSource: TurnTriggerSourceSchema.nullable().optional(),
  configVersion: z.number().int().positive().nullable(),
  /** Trusted role admission pins these facts before the first Provider call. */
  internalExecution: InternalAgentExecutionSchema.optional(),
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
