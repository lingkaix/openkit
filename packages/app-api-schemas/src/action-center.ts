import {
  ActorRefSchema,
  ArtifactIdSchema,
  ArtifactReviewIdSchema,
  ExecutionAttemptIdSchema,
  ItemIdSchema,
  KnowledgeOwnerScopeSchema,
  KnowledgeReviewIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
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
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    itemId: ItemIdSchema,
  })
  .strict();

/** Stable reference to one approval-backed attention source. */
export const ApprovalHumanAttentionSourceSchema = z
  .object({
    type: z.literal('approval'),
    approvalRequestId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    itemId: ItemIdSchema.optional(),
  })
  .strict();

/** Stable reference to one scheduler admission-backed attention source. */
export const SchedulerAdmissionHumanAttentionSourceSchema = z
  .object({
    type: z.literal('scheduler_admission'),
    queueEntryId: z.string().min(1),
    status: z.enum(['queued', 'denied']),
    denialReason: z.string().min(1).optional(),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    requestedAgentId: z.string().min(1),
  })
  .strict();

/** Stable reference to one rejected worker-control evidence source. */
export const WorkerControlRejectionHumanAttentionSourceSchema = z
  .object({
    type: z.literal('worker_control_rejection'),
    rejectionId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    packageSnapshotId: z.string().min(1),
    route: z.string().min(1),
    operation: z.string().min(1),
    errorCode: z.string().min(1),
    httpStatus: z.number().int().positive(),
  })
  .strict();

/** Exact execution attempt authority behind an unresolved worker attention row. */
export const ExecutionAttemptHumanAttentionSourceSchema = z
  .object({
    type: z.literal('execution_attempt'),
    attemptId: ExecutionAttemptIdSchema,
    backendId: z.string().min(1),
    phase: z.enum(['open', 'closing', 'closed']),
    disposition: z.enum(['not_accepted', 'accepted', 'unknown']),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
  })
  .strict();

/** Stable reference to one worker checkpoint-backed attention source. */
export const WorkerCheckpointHumanAttentionSourceSchema = z
  .object({
    type: z.literal('worker_checkpoint'),
    checkpointId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    stage: z.string().min(1),
    stopReason: z.string().min(1).nullable().optional(),
  })
  .strict();

/** Stable reference to one agent readiness-backed attention source. */
export const AgentReadinessHumanAttentionSourceSchema = z
  .object({
    type: z.literal('agent_readiness'),
    agentId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    status: z.string().min(1),
  })
  .strict();

/** Stable reference to one exact version-keyed Artifact Review attention source. */
export const ArtifactReviewHumanAttentionSourceSchema = z
  .object({
    type: z.literal('artifact_review'),
    reviewId: ArtifactReviewIdSchema,
    artifactId: ArtifactIdSchema,
    artifactVersion: z.number().int().positive(),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
  })
  .strict();

/** Stable reference to one staged workspace review-backed attention source. */
export const WorkspaceReviewHumanAttentionSourceSchema = z
  .object({
    type: z.literal('workspace_review'),
    reviewId: z.string().min(1),
    changeSetId: z.string().min(1),
    artifactId: ArtifactIdSchema.optional(),
    workspaceId: WorkspaceIdSchema,
    status: z.string().min(1),
  })
  .strict();

/** Stable reference to one workspace synchronization recovery-backed attention source. */
export const WorkspaceRecoveryHumanAttentionSourceSchema = z
  .object({
    type: z.literal('workspace_recovery'),
    reconciliationRecordId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
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
    proposalDigest: KnowledgeProposalContentDigestSchema,
    baseRevision: z.string().min(1),
    candidateRevision: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    status: z.string().min(1),
  })
  .strict();

/** Stable source references used by the unified Human Attention read model. */
export const HumanAttentionSourceSchema = z.discriminatedUnion('type', [
  ProtocolItemHumanAttentionSourceSchema,
  ApprovalHumanAttentionSourceSchema,
  SchedulerAdmissionHumanAttentionSourceSchema,
  WorkerControlRejectionHumanAttentionSourceSchema,
  ExecutionAttemptHumanAttentionSourceSchema,
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
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema.optional(),
    turnId: TurnIdSchema.optional(),
    itemId: ItemIdSchema.optional(),
    reviewId: z.string().min(1).optional(),
    artifactId: ArtifactIdSchema.optional(),
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
    proposalDigest: KnowledgeProposalContentDigestSchema,
    baseRevision: z.string().min(1),
    candidateRevision: z.string().min(1),
  })
  .strict();

/** Append-only human Knowledge Review row projected after one decision. */
export const KnowledgeProposalReviewSchema = z
  .object({
    proposalId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    ownerScope: KnowledgeOwnerScopeSchema,
    baseRevision: z.string().min(1),
    candidateRevision: z.string().min(1),
    reviewId: KnowledgeReviewIdSchema,
    requestId: RequestIdSchema,
    decision: KnowledgeProposalDecisionSchema,
    actor: ActorRefSchema,
    proposalDigest: KnowledgeProposalContentDigestSchema,
    knowledgePageId: KnowledgeProposalPageIdSchema.optional(),
    changedPageIds: z.array(z.string().min(1)).min(1).max(256).optional(),
    contentDigest: KnowledgeProposalContentDigestSchema,
    targetAbsentAtDecision: z.boolean().nullable(),
    decidedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) => (value.knowledgePageId !== undefined) !== (value.changedPageIds !== undefined),
    'Knowledge Proposal result must identify one complete candidate.'
  );

/** Knowledge Page result at the exact published commit named by its command. */
export const KnowledgeProposalApplicationSchema = z
  .object({
    knowledgePageId: KnowledgeProposalPageIdSchema.optional(),
    changedPageIds: z.array(z.string().min(1)).min(1).max(256).optional(),
    contentDigest: KnowledgeProposalContentDigestSchema,
    present: z.boolean(),
    notebookRevision: z.string().min(1),
  })
  .strict()
  .refine(
    (value) => (value.knowledgePageId !== undefined) !== (value.changedPageIds !== undefined),
    'Knowledge Proposal result must identify one complete candidate.'
  );

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
      (accepted
        ? !response.review.changedPageIds && response.review.targetAbsentAtDecision === null
        : response.review.targetAbsentAtDecision !== null) ||
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
        response.application.contentDigest !== response.review.contentDigest ||
        JSON.stringify(response.application.changedPageIds) !==
          JSON.stringify(response.review.changedPageIds))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Knowledge Proposal application must match its reviewed page and digest.',
      });
    }
  });

/** Request payload for restoring the original selected path after one reviewed change. */
export const ReverseKnowledgeProposalRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    baseRevision: z.string().min(1),
    confirmRemoval: z.literal(true).optional(),
    reviewId: KnowledgeReviewIdSchema,
    knowledgePageId: KnowledgeProposalPageIdSchema,
    expectedContentDigest: KnowledgeProposalContentDigestSchema,
  })
  .strict();

/** Derived post-reversal projection without a separate reversal record. */
export const ReverseKnowledgeProposalResponseSchema = z
  .object({
    proposalId: z.string().min(1),
    reviewId: KnowledgeReviewIdSchema,
    application: KnowledgeProposalApplicationSchema,
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
/** Knowledge Page result at the exact published commit named by its command. */
export type KnowledgeProposalApplication = z.infer<typeof KnowledgeProposalApplicationSchema>;
/** Response payload after recording one knowledge proposal decision. */
export type SubmitKnowledgeProposalDecisionResponse = z.infer<
  typeof SubmitKnowledgeProposalDecisionResponseSchema
>;
/** Request payload for restoring the original selected path after one reviewed change. */
export type ReverseKnowledgeProposalRequest = z.infer<typeof ReverseKnowledgeProposalRequestSchema>;
/** Derived post-reversal projection without a separate reversal record. */
export type ReverseKnowledgeProposalResponse = z.infer<
  typeof ReverseKnowledgeProposalResponseSchema
>;
