import { ActorRefSchema, RequestIdSchema, TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  KnowledgeProposalContentDigestSchema,
  KnowledgeProposalPageIdSchema,
} from './knowledge-manager.js';
import { WorkspaceSyncReviewDecisionSchema } from './workspace-sync.js';

/** Human attention row kinds projected by the product Action Center. */
export const HumanAttentionKindSchema = z.enum([
  'approval',
  'question',
  'artifact_review',
  'workspace_review',
  'blocked_turn',
  'review_cap',
  'budget',
  'checkpoint_recovery',
  'pending_input',
  'agent_readiness',
  'knowledge_review',
  'external_side_effect',
]);

/** Human attention severity used for sorting and product treatment. */
export const HumanAttentionSeveritySchema = z.enum(['info', 'needs_input', 'blocked', 'risk']);

/** Action kinds that the Action Center may render for one human attention row. */
export const HumanAttentionActionKindSchema = z.enum([
  'grant_approval',
  'deny_approval',
  'answer_question',
  'withdraw_request',
  'open_thread',
  'open_turn',
  'open_artifact',
  'run_follow_up',
  'accept_review',
  'request_refinement',
  'retry_work',
  'mark_blocked',
  'abort',
  'resume_from_checkpoint',
  'retry_from_checkpoint',
  'refresh_agent_readiness',
  'switch_agent',
  'accept_knowledge',
  'reject_knowledge',
  'defer',
  ...WorkspaceSyncReviewDecisionSchema.options,
]);

/** HTTP methods used by executable Action Center actions. */
export const HumanAttentionActionMethodSchema = z.enum(['GET', 'POST', 'PUT', 'DELETE']);

/** Stable reference to one protocol item-backed attention source. */
export const ProtocolItemHumanAttentionSourceSchema = z
  .object({
    type: z.literal('protocol_item'),
    itemType: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1),
  })
  .strict();

/** Stable reference to one approval-backed attention source. */
export const ApprovalHumanAttentionSourceSchema = z
  .object({
    type: z.literal('approval'),
    approvalRequestId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1).optional(),
  })
  .strict();

/** Stable reference to one scheduler admission-backed attention source. */
export const SchedulerAdmissionHumanAttentionSourceSchema = z
  .object({
    type: z.literal('scheduler_admission'),
    queueEntryId: z.string().min(1),
    status: z.enum(['queued', 'denied']),
    denialReason: z.string().min(1).optional(),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    requestedAgentId: z.string().min(1),
    priorityClass: z.enum(['interactive', 'automation', 'maintenance']),
  })
  .strict();

/** Stable reference to one rejected worker-control evidence source. */
export const WorkerControlRejectionHumanAttentionSourceSchema = z
  .object({
    type: z.literal('worker_control_rejection'),
    rejectionId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    packageSnapshotId: z.string().min(1),
    route: z.string().min(1),
    operation: z.string().min(1),
    errorCode: z.string().min(1),
    httpStatus: z.number().int().positive(),
  })
  .strict();

/** Stable reference to one scheduler orphan-worker evidence source. */
export const SchedulerOrphanWorkerHumanAttentionSourceSchema = z
  .object({
    type: z.literal('scheduler_orphan_worker'),
    evidenceId: z.string().min(1),
    leaseId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    packageSnapshotId: z.string().min(1),
    reason: z.string().min(1),
    schedulerEpoch: z.number().int().nonnegative(),
  })
  .strict();

/** Stable reference to one worker checkpoint-backed attention source. */
export const WorkerCheckpointHumanAttentionSourceSchema = z
  .object({
    type: z.literal('worker_checkpoint'),
    checkpointId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    stage: z.string().min(1),
    stopReason: z.string().min(1).nullable().optional(),
  })
  .strict();

/** Stable reference to one agent readiness-backed attention source. */
export const AgentReadinessHumanAttentionSourceSchema = z
  .object({
    type: z.literal('agent_readiness'),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

/** Stable reference to one exact version-keyed Artifact Review attention source. */
export const ArtifactReviewHumanAttentionSourceSchema = z
  .object({
    type: z.literal('artifact_review'),
    reviewId: z.string().min(1),
    artifactId: z.string().min(1),
    artifactVersion: z.number().int().positive(),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
  })
  .strict();

/** Stable reference to one staged workspace review-backed attention source. */
export const WorkspaceReviewHumanAttentionSourceSchema = z
  .object({
    type: z.literal('workspace_review'),
    reviewId: z.string().min(1),
    changeSetId: z.string().min(1),
    artifactId: z.string().min(1).optional(),
    workspaceId: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

/** Stable reference to one workspace synchronization recovery-backed attention source. */
export const WorkspaceRecoveryHumanAttentionSourceSchema = z
  .object({
    type: z.literal('workspace_recovery'),
    reconciliationRecordId: z.string().min(1),
    workspaceId: z.string().min(1),
    triggerReason: z.enum(['restart', 'backend_takeover', 'manual']),
    stateAfter: z.literal('requires-human'),
    affectedRecordIds: z.array(z.string().min(1)),
    evidenceBundleIds: z.array(z.string().min(1)),
    requiredHumanDecision: z.string().min(1).nullable(),
  })
  .strict();

/** Stable reference to one knowledge proposal-backed attention source. */
export const KnowledgeHumanAttentionSourceSchema = z
  .object({
    type: z.literal('knowledge'),
    knowledgeProposalId: z.string().min(1),
    workspaceId: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

/** Stable source references used by the unified Human Attention read model. */
export const HumanAttentionSourceSchema = z.discriminatedUnion('type', [
  ProtocolItemHumanAttentionSourceSchema,
  ApprovalHumanAttentionSourceSchema,
  SchedulerAdmissionHumanAttentionSourceSchema,
  WorkerControlRejectionHumanAttentionSourceSchema,
  SchedulerOrphanWorkerHumanAttentionSourceSchema,
  WorkerCheckpointHumanAttentionSourceSchema,
  AgentReadinessHumanAttentionSourceSchema,
  ArtifactReviewHumanAttentionSourceSchema,
  WorkspaceReviewHumanAttentionSourceSchema,
  WorkspaceRecoveryHumanAttentionSourceSchema,
  KnowledgeHumanAttentionSourceSchema,
]);

/** Product action attached to one Human Attention row. */
export const HumanAttentionActionSchema = z
  .object({
    kind: HumanAttentionActionKindSchema,
    label: z.string().min(1),
    method: HumanAttentionActionMethodSchema.optional(),
    href: z.string().min(1).optional(),
    disabled: z.boolean().optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

/** Unified product read-model row for any human attention source. */
export const HumanAttentionRowSchema = z
  .object({
    id: z.string().min(1),
    kind: HumanAttentionKindSchema,
    workspaceId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    itemId: z.string().min(1).optional(),
    reviewId: z.string().min(1).optional(),
    artifactId: z.string().min(1).optional(),
    artifactVersion: z.number().int().positive().optional(),
    goalId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    title: z.string().min(1),
    summary: z.string().min(1),
    severity: HumanAttentionSeveritySchema,
    createdAt: z.string().min(1),
    ageSeconds: z.number().int().nonnegative().optional(),
    turnsSince: z.number().int().nonnegative().optional(),
    blocking: z.boolean().optional(),
    recommendedAction: z.string().min(1).optional(),
    source: HumanAttentionSourceSchema,
    actions: z.array(HumanAttentionActionSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source.type !== 'artifact_review') {
      return;
    }
    if (
      value.kind !== 'artifact_review' ||
      value.id !== `artifact-review:${value.source.reviewId}` ||
      value.workspaceId !== value.source.workspaceId ||
      value.threadId !== value.source.threadId ||
      value.turnId !== value.source.turnId ||
      value.reviewId !== value.source.reviewId ||
      value.artifactId !== value.source.artifactId ||
      value.artifactVersion !== value.source.artifactVersion
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact Review rows require exact version-owned source lineage.',
        path: ['source'],
      });
    }
  });

/** Unified Human Attention Action Center response payload. */
export const ListHumanAttentionResponseSchema = z
  .object({
    items: z.array(HumanAttentionRowSchema),
  })
  .strict();

/** Human attention row kind projected by the product Action Center. */
export type HumanAttentionKind = z.infer<typeof HumanAttentionKindSchema>;
/** Human attention row severity. */
export type HumanAttentionSeverity = z.infer<typeof HumanAttentionSeveritySchema>;
/** Product action kind attached to one Human Attention row. */
export type HumanAttentionActionKind = z.infer<typeof HumanAttentionActionKindSchema>;
/** Product action attached to one Human Attention row. */
export type HumanAttentionAction = z.infer<typeof HumanAttentionActionSchema>;
/** Stable source reference for one Human Attention row. */
export type HumanAttentionSource = z.infer<typeof HumanAttentionSourceSchema>;
/** Unified product read-model row for any human attention source. */
export type HumanAttentionRow = z.infer<typeof HumanAttentionRowSchema>;
/** Unified Human Attention Action Center response payload. */
export type ListHumanAttentionResponse = z.infer<typeof ListHumanAttentionResponseSchema>;

/** Artifact review decisions accepted by the app-local Action Center workflow. */
export const ArtifactReviewDecisionSchema = z.enum([
  'accepted',
  'needs_refinement',
  'redo',
  'rejected',
  'deferred',
]);

/** Knowledge proposal decisions accepted by the app-local Action Center workflow. */
export const KnowledgeProposalDecisionSchema = z.enum(['accepted', 'rejected', 'deferred']);

/** Request payload for recording one knowledge proposal decision. */
export const SubmitKnowledgeProposalDecisionRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    decision: KnowledgeProposalDecisionSchema,
  })
  .strict();

/** Append-only human Knowledge Review row projected after one decision. */
export const KnowledgeProposalReviewSchema = z
  .object({
    proposalId: z.string().min(1),
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    requestId: RequestIdSchema,
    decision: KnowledgeProposalDecisionSchema,
    actor: ActorRefSchema,
    proposalDigest: KnowledgeProposalContentDigestSchema,
    knowledgePageId: KnowledgeProposalPageIdSchema,
    contentDigest: KnowledgeProposalContentDigestSchema,
    targetAbsentAtDecision: z.boolean().nullable(),
    decidedAt: TimestampSchema,
  })
  .strict();

/** Current Knowledge Page presence projected from proposal-owned application lineage. */
export const KnowledgeProposalApplicationSchema = z
  .object({
    knowledgePageId: KnowledgeProposalPageIdSchema,
    contentDigest: KnowledgeProposalContentDigestSchema,
    present: z.boolean(),
  })
  .strict();

/** Response payload after recording one knowledge proposal decision. */
export const SubmitKnowledgeProposalDecisionResponseSchema = z
  .object({
    review: KnowledgeProposalReviewSchema,
    application: KnowledgeProposalApplicationSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    const accepted = response.review.decision === 'accepted';
    if (
      response.review.targetAbsentAtDecision !== (accepted ? true : null) ||
      (accepted ? response.application?.present !== true : response.application !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Knowledge Proposal application must match its review decision.',
      });
    }
    if (
      response.application &&
      (response.application.knowledgePageId !== response.review.knowledgePageId ||
        response.application.contentDigest !== response.review.contentDigest)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Knowledge Proposal application must match its reviewed page and digest.',
      });
    }
  });

/** Request payload for removing one unchanged proposal-created Knowledge Page. */
export const ReverseKnowledgeProposalRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    reviewId: z.string().min(1),
    knowledgePageId: KnowledgeProposalPageIdSchema,
    expectedContentDigest: KnowledgeProposalContentDigestSchema,
  })
  .strict();

/** Derived post-reversal projection without a separate reversal record. */
export const ReverseKnowledgeProposalResponseSchema = z
  .object({
    proposalId: z.string().min(1),
    reviewId: z.string().min(1),
    application: KnowledgeProposalApplicationSchema.extend({ present: z.literal(false) }),
  })
  .strict();

/** Artifact review decision accepted by the app-local Action Center workflow. */
export type ArtifactReviewDecision = z.infer<typeof ArtifactReviewDecisionSchema>;
/** Knowledge proposal decision accepted by the app-local Action Center workflow. */
export type KnowledgeProposalDecision = z.infer<typeof KnowledgeProposalDecisionSchema>;
/** Request payload for recording one knowledge proposal decision. */
export type SubmitKnowledgeProposalDecisionRequest = z.infer<
  typeof SubmitKnowledgeProposalDecisionRequestSchema
>;
/** Append-only human Knowledge Review row projected after one decision. */
export type KnowledgeProposalReview = z.infer<typeof KnowledgeProposalReviewSchema>;
/** Current Knowledge Page presence projected from proposal-owned application lineage. */
export type KnowledgeProposalApplication = z.infer<typeof KnowledgeProposalApplicationSchema>;
/** Response payload after recording one knowledge proposal decision. */
export type SubmitKnowledgeProposalDecisionResponse = z.infer<
  typeof SubmitKnowledgeProposalDecisionResponseSchema
>;
/** Request payload for removing one unchanged proposal-created Knowledge Page. */
export type ReverseKnowledgeProposalRequest = z.infer<typeof ReverseKnowledgeProposalRequestSchema>;
/** Derived post-reversal projection without a separate reversal record. */
export type ReverseKnowledgeProposalResponse = z.infer<
  typeof ReverseKnowledgeProposalResponseSchema
>;
