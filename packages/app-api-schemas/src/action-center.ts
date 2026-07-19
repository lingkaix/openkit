import { z } from 'zod';
import { WorkspaceSyncReviewDecisionSchema } from './workspace-sync.js';

/** Goal Review decision values owned by the Goal Review record. */
export const GoalReviewVerdictSchema = z.enum(['accept', 'refine', 'retry', 'abort']);

/** Closed result values stored in one immutable Goal Review resolution snapshot. */
export const GoalReviewResolutionOutcomeSchema = z.enum([
  'complete_next_task',
  'complete_goal',
  'refine',
  'retry',
  'aborted',
]);

/** Bounded immutable result stored after one Goal Review decision. */
export const GoalReviewResolutionSnapshotSchema = z
  .object({
    outcome: GoalReviewResolutionOutcomeSchema,
    task: z
      .object({
        taskId: z.string().min(1),
        status: z.enum(['completed', 'ready', 'failed']),
      })
      .strict(),
    goal: z
      .object({
        goalId: z.string().min(1),
        status: z.enum(['running', 'completed', 'aborted']),
        currentTaskId: z.null(),
        terminalStopReason: z.enum(['completed', 'aborted']).nullable(),
      })
      .strict(),
    nextReadyTaskId: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const invalid = (message: string): void =>
      context.addIssue({ code: 'custom', message, path: ['outcome'] });

    if (
      value.outcome === 'complete_goal' &&
      (value.task.status !== 'completed' ||
        value.goal.status !== 'completed' ||
        value.goal.terminalStopReason !== 'completed' ||
        value.nextReadyTaskId !== null)
    ) {
      invalid('A complete_goal snapshot requires completed Task and Goal terminal state.');
    }
    if (
      value.outcome === 'complete_next_task' &&
      (value.task.status !== 'completed' ||
        value.goal.status !== 'running' ||
        value.goal.terminalStopReason !== null ||
        value.nextReadyTaskId === null)
    ) {
      invalid('A nonterminal completion snapshot has inconsistent Task, Goal, or next Task state.');
    }
    if (
      (value.outcome === 'refine' || value.outcome === 'retry') &&
      (value.task.status !== 'ready' ||
        value.goal.status !== 'running' ||
        value.goal.terminalStopReason !== null ||
        value.nextReadyTaskId !== value.task.taskId)
    ) {
      invalid('A refine or retry snapshot must return the reviewed Task to ready.');
    }
    if (
      value.outcome === 'aborted' &&
      (value.task.status !== 'failed' ||
        value.goal.status !== 'aborted' ||
        value.goal.terminalStopReason !== 'aborted' ||
        value.nextReadyTaskId !== null)
    ) {
      invalid('An aborted snapshot requires a failed Task and aborted Goal.');
    }
  });

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
  'open_thread',
  'open_turn',
  'open_artifact',
  'submit_steering',
  'run_follow_up',
  'review_goal_plan',
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
    agentSessionId: z.string().min(1),
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
    agentSessionId: z.string().min(1),
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

/** Stable reference to one app-local goal-backed attention source. */
export const GoalHumanAttentionSourceSchema = z
  .object({
    type: z.literal('goal'),
    goalId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

/** Stable reference to one app-local goal task-backed attention source. */
export const GoalTaskHumanAttentionSourceSchema = z
  .object({
    type: z.literal('goal_task'),
    goalId: z.string().min(1),
    taskId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

/** Stable reference to one app-local goal review-backed attention source. */
export const GoalReviewHumanAttentionSourceSchema = z
  .object({
    type: z.literal('goal_review'),
    reviewId: z.string().min(1),
    goalId: z.string().min(1),
    taskId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
  })
  .strict();

/** Verified pending-input source for one accepted Goal steering command. */
export const PendingGoalSteeringHumanAttentionSourceSchema = z
  .object({
    type: z.literal('pending_input'),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    pendingTurnId: z.string().min(1),
    requestId: z.string().min(1),
    contentItemId: z.string().min(1),
    goalId: z.string().min(1),
    activeTurnId: z.string().min(1),
    state: z.enum(['queued', 'applied']),
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
  GoalHumanAttentionSourceSchema,
  GoalTaskHumanAttentionSourceSchema,
  GoalReviewHumanAttentionSourceSchema,
  PendingGoalSteeringHumanAttentionSourceSchema,
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
    agentSessionId: z.string().min(1).optional(),
    goalId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    title: z.string().min(1),
    summary: z.string().min(1),
    severity: HumanAttentionSeveritySchema,
    createdAt: z.string().min(1),
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
    decision: KnowledgeProposalDecisionSchema,
    requestId: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

/** Response payload after recording one knowledge proposal decision. */
export const SubmitKnowledgeProposalDecisionResponseSchema = z
  .object({
    review: z
      .object({
        proposalId: z.string().min(1),
        workspaceId: z.string().min(1),
        status: KnowledgeProposalDecisionSchema,
        message: z.string().min(1).nullable(),
        decidedAt: z.string().min(1),
        requestId: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

/** Request payload for resolving one app-local Goal Review attention row. */
export const SubmitGoalReviewDecisionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    verdict: GoalReviewVerdictSchema,
    reason: z.string().min(1).optional(),
    revisionInstruction: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.verdict === 'retry' || value.verdict === 'abort') && !value.reason) {
      context.addIssue({
        code: 'custom',
        message: `${value.verdict} requires a reason.`,
        path: ['reason'],
      });
    }
    if (value.verdict === 'refine' && !value.revisionInstruction) {
      context.addIssue({
        code: 'custom',
        message: 'refine requires a revision instruction.',
        path: ['revisionInstruction'],
      });
    }
    if (value.verdict !== 'refine' && value.revisionInstruction !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'revisionInstruction is only valid for refine.',
        path: ['revisionInstruction'],
      });
    }
  });

/** Response payload after resolving one app-local Goal Review attention row. */
export const SubmitGoalReviewDecisionResponseSchema = z
  .object({
    review: z
      .object({
        reviewId: z.string().min(1),
        workspaceId: z.string().min(1),
        threadId: z.string().min(1),
        goalId: z.string().min(1),
        taskId: z.string().min(1),
        turnId: z.string().min(1),
        itemIds: z.array(z.string().min(1)),
        artifactIds: z.array(z.string().min(1)),
        verificationEvidence: z.array(z.unknown()),
        prompt: z.string().min(1),
        createdByRequestId: z.string().min(1),
        verdict: GoalReviewVerdictSchema,
        reason: z.string().min(1).nullable(),
        revisionInstruction: z.string().min(1).nullable(),
        createdAt: z.string().min(1),
        updatedAt: z.string().min(1),
        resolvedAt: z.string().min(1),
        resolutionRequestId: z.string().min(1),
        resolvedByActorId: z.string().min(1),
      })
      .strict()
      .superRefine((value, context) => {
        if ((value.verdict === 'retry' || value.verdict === 'abort') && !value.reason) {
          context.addIssue({
            code: 'custom',
            message: `${value.verdict} requires a reason.`,
            path: ['reason'],
          });
        }
        if (value.verdict === 'refine' && !value.revisionInstruction) {
          context.addIssue({
            code: 'custom',
            message: 'refine requires a revision instruction.',
            path: ['revisionInstruction'],
          });
        }
        if (value.verdict !== 'refine' && value.revisionInstruction !== null) {
          context.addIssue({
            code: 'custom',
            message: 'revisionInstruction is only valid for refine.',
            path: ['revisionInstruction'],
          });
        }
      }),
    advance: GoalReviewResolutionSnapshotSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedOutcomes: Record<GoalReviewVerdict, readonly GoalReviewResolutionOutcome[]> = {
      abort: ['aborted'],
      accept: ['complete_next_task', 'complete_goal'],
      refine: ['refine'],
      retry: ['retry'],
    };
    if (!expectedOutcomes[value.review.verdict].includes(value.advance.outcome)) {
      context.addIssue({
        code: 'custom',
        message: 'The Goal Review verdict and resolution outcome are inconsistent.',
        path: ['advance', 'outcome'],
      });
    }
    if (value.advance.task.taskId !== value.review.taskId) {
      context.addIssue({
        code: 'custom',
        message: 'The resolution Task does not match the reviewed Task.',
        path: ['advance', 'task', 'taskId'],
      });
    }
    if (value.advance.goal.goalId !== value.review.goalId) {
      context.addIssue({
        code: 'custom',
        message: 'The resolution Goal does not match the reviewed Goal.',
        path: ['advance', 'goal', 'goalId'],
      });
    }
  });

/** Artifact review decision accepted by the app-local Action Center workflow. */
export type ArtifactReviewDecision = z.infer<typeof ArtifactReviewDecisionSchema>;
/** Goal Review decision owned by one Goal Review record. */
export type GoalReviewVerdict = z.infer<typeof GoalReviewVerdictSchema>;
/** Closed result stored in one Goal Review resolution snapshot. */
export type GoalReviewResolutionOutcome = z.infer<typeof GoalReviewResolutionOutcomeSchema>;
/** Immutable result stored after one Goal Review decision. */
export type GoalReviewResolutionSnapshot = z.infer<typeof GoalReviewResolutionSnapshotSchema>;
/** Knowledge proposal decision accepted by the app-local Action Center workflow. */
export type KnowledgeProposalDecision = z.infer<typeof KnowledgeProposalDecisionSchema>;
/** Request payload for recording one knowledge proposal decision. */
export type SubmitKnowledgeProposalDecisionRequest = z.infer<
  typeof SubmitKnowledgeProposalDecisionRequestSchema
>;
/** Response payload after recording one knowledge proposal decision. */
export type SubmitKnowledgeProposalDecisionResponse = z.infer<
  typeof SubmitKnowledgeProposalDecisionResponseSchema
>;
/** Request payload for resolving one app-local Goal Review attention row. */
export type SubmitGoalReviewDecisionRequest = z.infer<typeof SubmitGoalReviewDecisionRequestSchema>;
/** Response payload after resolving one app-local Goal Review attention row. */
export type SubmitGoalReviewDecisionResponse = z.infer<
  typeof SubmitGoalReviewDecisionResponseSchema
>;
