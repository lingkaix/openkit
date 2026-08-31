import { ItemSchema, ProductTurnSchema } from '@openkit/protocol';
import { z } from 'zod';

/** One immutable Artifact version referenced by a conversation submission. */
export const ConversationArtifactReferenceSchema = z
  .object({
    artifactId: z.string().min(1),
    artifactVersion: z.number().int().positive(),
  })
  .strict();

/** Product-safe logical model choice published for one conversation target. */
export const ConversationModelChoiceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    capabilities: z.array(z.string().min(1)),
  })
  .strict();

/** Workspace-scoped conversation target projection. */
export const ConversationTargetSchema = z
  .object({
    targetRef: z.string().min(1),
    kind: z.enum([
      'assistant',
      'knowledge-manager',
      'goal-orchestrator',
      'warm-worker',
      'running-worker',
      'new-task-worker',
    ]),
    label: z.string().min(1),
    description: z.string().min(1).nullable(),
    availability: z.enum(['available', 'busy', 'unavailable']),
    unavailableReason: z.string().min(1).nullable(),
    threadId: z.string().min(1).nullable(),
    profileId: z.string().min(1).nullable(),
    logicalModels: z.array(ConversationModelChoiceSchema),
    defaultLogicalModelId: z.string().min(1).nullable(),
  })
  .strict();

/** Context-sensitive target catalog returned to the shared Composer. */
export const ConversationTargetCatalogSchema = z
  .object({
    workspaceId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    targets: z.array(ConversationTargetSchema),
    defaultTargetRef: z.string().min(1),
  })
  .strict();

/** Request body for one structured conversation submission. */
export const SubmitConversationRequestSchema = z
  .object({
    input: z.string(),
    targetRef: z.string().min(1),
    logicalModelId: z.string().min(1).optional(),
    artifactRefs: z.array(ConversationArtifactReferenceSchema).default([]),
    requestId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.input.trim() && value.artifactRefs.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Conversation input or an Artifact is required.' });
    }
    const refs = new Set<string>();
    for (const [index, artifact] of value.artifactRefs.entries()) {
      const key = `${artifact.artifactId}:${artifact.artifactVersion}`;
      if (refs.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate Artifact reference.',
          path: ['artifactRefs', index],
        });
      }
      refs.add(key);
    }
  });

/** Terminal routing outcome selected by Core Assistant. */
export const ChatModeOutcomeSchema = z.enum([
  'answered',
  'clarification-needed',
  'task-handoff',
  'goal-handoff',
  'accepted',
  'refused',
]);

/** App API projection for a Chat Mode handoff status item. */
export const ChatModeHandoffSchema = z.object({
  targetMode: z.enum(['task', 'goal']),
  reason: z.string().min(1),
  statusItemId: z.string().min(1),
});

/** Response returned after Core Assistant records one Chat Mode outcome. */
export const SubmitConversationResponseSchema = z.object({
  outcome: ChatModeOutcomeSchema,
  explanation: z.string().min(1),
  turn: ProductTurnSchema,
  item: ItemSchema,
  handoff: ChatModeHandoffSchema.nullable(),
  originatingWorkspaceId: z.string().min(1),
  originatingThreadId: z.string().min(1),
  receivingWorkspaceId: z.string().min(1),
  receivingThreadId: z.string().min(1),
  targetRef: z.string().min(1),
  logicalModelId: z.string().min(1).nullable(),
});

/** Structured conversation submission. */
export type SubmitConversationRequest = z.infer<typeof SubmitConversationRequestSchema>;
/** Structured conversation response. */
export type SubmitConversationResponse = z.infer<typeof SubmitConversationResponseSchema>;
/** Workspace-scoped target catalog. */
export type ConversationTargetCatalog = z.infer<typeof ConversationTargetCatalogSchema>;
