import {
  ArtifactSchema,
  ItemSchema,
  ProductTurnSchema,
  StopReasonSchema,
  ThreadSchema,
  TimestampSchema,
  TurnStatusSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { GoalReviewResolutionOutcomeSchema, GoalReviewVerdictSchema } from './action-center.js';
import { WorkspaceMaterialRevisionSummarySchema } from './material.js';
import { TaskModeContextRefSchema } from './task-mode.js';

/** Product work modes surfaced by app-level dashboard read models. */
export const ProductWorkModeSchema = z.enum([
  'chat',
  'automation',
  'plan',
  'review',
  'organize',
  'delegation',
]);

/** Current status for a thread workbench, including the idle no-turn state. */
export const ActiveTurnStatusSchema = z.union([TurnStatusSchema, z.literal('idle')]);

/** Routing decision summary returned by NanoCore app dashboards. */
export const WorkRoutingSchema = z.object({
  decision: z.enum([
    'quick_chat',
    'worker_turn',
    'review',
    'plan',
    'organize',
    'delegation',
    'handoff',
    'unsupported',
    'idle',
  ]),
  explanation: z.string(),
  selectedAgentId: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  requiredUserAction: z.string().min(1).nullable(),
});

/** Compact artifact summary shown in product work status surfaces. */
export const DashboardArtifactSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: ArtifactSchema.shape.status,
  summary: z.string().nullable(),
  updatedAt: z.string().min(1),
});

/** Active work row shown on the workspace home dashboard. */
export const WorkspaceActiveWorkSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1),
  status: TurnStatusSchema,
  mode: ProductWorkModeSchema,
  agentId: z.string().min(1).nullable(),
  summary: z.string().nullable(),
  updatedAt: z.string().min(1),
});

/** Recent completed turn row shown on the workspace home dashboard. */
export const WorkspaceCompletionSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1),
  turnId: z.string().min(1),
  completedAt: z.string().min(1),
  artifactCount: z.number().int().nonnegative(),
  summary: z.string().nullable(),
});

/** Attention row shown on the workspace home dashboard. */
export const WorkspaceAttentionSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1),
  turnId: z.string().min(1),
  kind: z.enum(['approval', 'question', 'failed', 'interrupted', 'cancelled']),
  itemId: z.string().min(1).nullable(),
  summary: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** Thread-level product work status shown above the protocol item stream. */
export const ThreadWorkStatusSchema = z.object({
  currentMode: ProductWorkModeSchema,
  selectedAgentId: z.string().min(1).nullable(),
  activeTurnStatus: ActiveTurnStatusSchema,
  pendingApprovalCount: z.number().int().nonnegative(),
  pendingQuestionCount: z.number().int().nonnegative(),
  latestArtifact: DashboardArtifactSummarySchema.nullable(),
  routing: WorkRoutingSchema,
});

/** App-local Goal Mode lifecycle status surfaced through App API read models. */
export const GoalReadModelStatusSchema = z.enum([
  'planning',
  'awaiting_plan_approval',
  'running',
  'paused',
  'awaiting_user',
  'reviewing',
  'completed',
  'blocked',
  'aborted',
  'failed',
]);

/** App-local Goal Mode task lifecycle status surfaced through App API read models. */
export const GoalTaskReadModelStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'reviewing',
  'completed',
  'blocked',
  'failed',
]);

/** Current task summary inside a thread goal read model. */
export const ThreadGoalCurrentTaskSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  status: GoalTaskReadModelStatusSchema,
  orderIndex: z.number().int().nonnegative(),
});

/** Goal task counts keyed by task status. */
export const GoalTaskCountsSchema = z.object({
  pending: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  reviewing: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/** Pending human attention summary for one goal read model. */
export const GoalPendingHumanAttentionSchema = z.object({
  required: z.boolean(),
  reason: z.string().min(1).nullable(),
});

/** Terminal state summary for one closed goal. */
export const GoalTerminalStateSchema = z.object({
  status: z.enum(['completed', 'blocked', 'aborted', 'failed']),
  stopReason: StopReasonSchema.nullable(),
});

/** Verification evidence shown in a terminal Goal Mode summary. */
export const GoalTerminalVerificationEvidenceSchema = z.object({
  verificationId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped', 'unavailable', 'manual_required']),
  summary: z.string().min(1),
  command: z.string().min(1).nullable(),
  artifactIds: z.array(z.string().min(1)).max(100),
});

/** Structured terminal summary for one closed Goal Mode run. */
export const GoalTerminalSummarySchema = z.object({
  completedTaskIds: z.array(z.string().min(1)).max(100),
  blockedTaskIds: z.array(z.string().min(1)).max(100),
  artifactIds: z.array(z.string().min(1)).max(100),
  verificationEvidence: z.array(GoalTerminalVerificationEvidenceSchema).max(100),
  risks: z.array(z.string().min(1).max(1_000)).max(50),
  suggestedNextWork: z.array(z.string().min(1).max(1_000)).max(50),
});

/** Thread-level Goal Mode summary read model. */
export const ThreadGoalSummarySchema = z.object({
  goalId: z.string().min(1),
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  status: GoalReadModelStatusSchema,
  title: z.string().min(1),
  objective: z.string().min(1),
  currentTask: ThreadGoalCurrentTaskSchema.nullable(),
  taskCounts: GoalTaskCountsSchema,
  pendingHumanAttention: GoalPendingHumanAttentionSchema,
  terminalState: GoalTerminalStateSchema.nullable(),
  terminalSummary: GoalTerminalSummarySchema.nullable().optional(),
  updatedAt: z.string().min(1),
});

/** Thread goal summary response payload. */
export const ThreadGoalSummaryResponseSchema = z.object({
  goal: ThreadGoalSummarySchema.nullable(),
});

/** Request body for starting Goal Mode from one thread. */
export const StartThreadGoalRequestSchema = z.object({
  requestId: z.string().min(1),
  objective: z.string().min(1),
  title: z.string().min(1).optional(),
});

/** Response payload returned after starting Goal Mode from one thread. */
export const StartThreadGoalResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
  objectiveItemId: z.string().min(1),
});

/** Request body for pausing Goal Mode at one safe thread boundary. */
export const PauseThreadGoalRequestSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .strict();

/** Response payload returned after pausing Goal Mode for one thread. */
export const PauseThreadGoalResponseSchema = z.object({
  outcome: z.literal('paused'),
  goal: ThreadGoalSummarySchema,
});

/** Request body for resuming Goal Mode at one safe thread boundary. */
export const ResumeThreadGoalRequestSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .strict();

/** Response payload returned after resuming Goal Mode for one thread. */
export const ResumeThreadGoalResponseSchema = z.object({
  outcome: z.literal('resumed'),
  goal: ThreadGoalSummarySchema,
});

/** Message request body for submitting steering to an active Goal Mode thread. */
export const SubmitThreadGoalSteeringMessageRequestSchema = z
  .object({
    requestId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/** Exact Material request body for submitting steering to an active Goal Mode thread. */
export const SubmitThreadGoalSteeringMaterialRequestSchema = z
  .object({
    requestId: z.string().min(1),
    materialId: z.string().min(1),
    revisionId: z.string().min(1),
    contentDigest: WorkspaceMaterialRevisionSummarySchema.shape.contentDigest,
    note: z.string().min(1).optional(),
  })
  .strict();

/** Request body for submitting message or exact Material steering to an active Goal Mode thread. */
export const SubmitThreadGoalSteeringRequestSchema = z.union([
  SubmitThreadGoalSteeringMessageRequestSchema,
  SubmitThreadGoalSteeringMaterialRequestSchema,
]);

/** Response payload returned after submitting Goal Mode steering. */
export const SubmitThreadGoalSteeringResponseSchema = z
  .object({
    state: z.literal('queued'),
    pendingTurnId: z.string().min(1),
    requestId: z.string().min(1),
    contentItemId: z.string().min(1),
    goalId: z.string().min(1),
    activeTurnId: z.string().min(1),
  })
  .strict();

/** Request body for converting terminal Goal steering into Thread follow-up history. */
export const ConvertGoalSteeringToFollowUpRequestSchema = z
  .object({ requestId: z.string().min(1) })
  .strict();

/** Request body for cancelling terminal Goal steering. */
export const CancelGoalSteeringRequestSchema = ConvertGoalSteeringToFollowUpRequestSchema;

const goalSteeringTerminalResponseBaseSchema = z
  .object({
    pendingTurnId: z.string().min(1),
    requestId: z.string().min(1),
    sourceRequestId: z.string().min(1),
    contentItemId: z.string().min(1),
    goalId: z.string().min(1),
    activeTurnId: z.string().min(1),
  })
  .strict();

/** Response payload after converting terminal Goal steering into Thread follow-up history. */
export const ConvertGoalSteeringToFollowUpResponseSchema =
  goalSteeringTerminalResponseBaseSchema.extend({
    state: z.literal('follow-up'),
    followUpTurnId: z.string().min(1),
    followUpItemId: z.string().min(1),
  });

/** Response payload after cancelling terminal Goal steering. */
export const CancelGoalSteeringResponseSchema = goalSteeringTerminalResponseBaseSchema.extend({
  state: z.literal('cancelled'),
});

/** Resource reference selected by a Goal Mode plan task. */
export const ThreadGoalPlanTaskResourceSchema = z.object({
  kind: z.enum(['repository', 'file', 'item', 'artifact', 'knowledge', 'external']),
  reference: z.string().min(1).max(1_000),
  reason: z.string().min(1).max(1_000),
});

/** Expected output from one Goal Mode plan task. */
export const ThreadGoalPlanExpectedArtifactSchema = z.object({
  kind: z.enum(['code-change', 'test-result', 'document', 'artifact']),
  description: z.string().min(1).max(1_000),
});

/** Verification check proposed for one Goal Mode plan task. */
export const ThreadGoalPlanVerificationCheckSchema = z.object({
  kind: z.enum(['command', 'test', 'manual']),
  description: z.string().min(1).max(1_000),
  command: z.string().min(1).max(1_000).optional(),
});

/** Human review policy proposed for one Goal Mode plan task. */
export const ThreadGoalPlanReviewPolicySchema = z.object({
  required: z.boolean(),
  reviewers: z.tuple([z.literal('human')]),
  instructions: z.string().min(1).max(2_000),
});

/** One task proposed by a Goal Mode plan. */
export const ThreadGoalPlanTaskSchema = z.object({
  taskId: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(2_000),
  acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
  contextBudgetTokens: z.number().int().positive().max(240_000),
  resources: z.array(ThreadGoalPlanTaskResourceSchema).max(50),
  expectedArtifacts: z.array(ThreadGoalPlanExpectedArtifactSchema).max(20),
  verificationChecks: z.array(ThreadGoalPlanVerificationCheckSchema).min(1).max(20),
  reviewPolicy: ThreadGoalPlanReviewPolicySchema,
  dependsOnTaskIds: z.array(z.string().min(1).max(120)).max(20),
  escalationConditions: z.array(z.string().min(1).max(1_000)).max(20),
});

/** Reviewable Goal Mode plan payload exchanged by App API routes. */
export const ThreadGoalPlanSchema = z.object({
  schemaVersion: z.literal(1),
  goalSummary: z.string().min(1).max(2_000),
  assumptions: z.array(z.string().min(1).max(1_000)).max(20),
  tasks: z.array(ThreadGoalPlanTaskSchema).min(1).max(50),
  risks: z.array(z.string().min(1).max(1_000)).max(20),
  questions: z.array(z.string().min(1).max(1_000)).max(20),
  verificationApproach: z.string().min(1).max(2_000),
});

/** Response payload returned after creating a Goal Mode plan. */
export const GoalPlanPlannerSummarySchema = z.object({
  mode: z.literal('goal'),
  sourceAgentId: z.literal('worker-coordinator'),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  contextRefs: z.array(TaskModeContextRefSchema).min(1).max(50),
  requiredApprovals: z.array(z.string().min(1)).max(20),
  plan: ThreadGoalPlanSchema,
});

/** Request body for creating one Goal Mode plan. */
export const CreateThreadGoalPlanRequestSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .strict();

/** Response payload returned after creating a Goal Mode plan. */
export const CreateThreadGoalPlanResponseSchema = z.object({
  status: z.literal('awaiting_plan_approval'),
  goal: ThreadGoalSummarySchema,
  planItemId: z.string().min(1),
  planner: GoalPlanPlannerSummarySchema,
  plan: ThreadGoalPlanSchema,
});

/** Request body for approving one Goal Mode plan. */
export const ApproveThreadGoalPlanRequestSchema = z
  .object({
    requestId: z.string().min(1),
    planItemId: z.string().min(1),
  })
  .strict();

/** Ready task summary returned after approving one Goal Mode plan. */
export const ApprovedThreadGoalTaskSchema = z.object({
  taskId: z.string().min(1),
  status: z.literal('ready'),
});

/** Response payload returned after approving one Goal Mode plan. */
export const ApproveThreadGoalPlanResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
  readyTasks: z.array(ApprovedThreadGoalTaskSchema),
  startsWorkerTurn: z.literal(false),
});

/** Request body for asking Goal Mode to revise the active plan draft. */
export const ReviseThreadGoalPlanRequestSchema = z
  .object({
    requestId: z.string().min(1),
    revision: z.string().min(1).max(4_000),
  })
  .strict();

/** Response payload returned after requesting Goal Mode plan revisions. */
export const ReviseThreadGoalPlanResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
  revisionItemId: z.string().min(1),
  startsWorkerTurn: z.literal(false),
});

/** Product-safe context assembly summary for one bounded worker step. */
export const GoalStepContextAssemblySchema = z.object({
  contextDigest: z.string().min(1),
  contextRefs: z.array(TaskModeContextRefSchema).min(1).max(50),
});

/** Request body for running one real bounded Goal Mode worker step. */
export const RunThreadGoalStepRequestSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .strict();

/** Response payload returned after running one real bounded Goal Mode worker step. */
export const RunThreadGoalStepResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
});

/** Request body for running one deterministic Goal Mode supervise step. */
export const RunThreadGoalTestSuperviseStepRequestSchema = z.object({
  verdict: GoalReviewVerdictSchema.default('accept'),
});

/** Response payload returned after running one deterministic Goal Mode supervise step. */
export const RunThreadGoalTestSuperviseStepResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
  task: ThreadGoalCurrentTaskSchema,
  worker: z.object({
    turnId: z.string().min(1),
    stopReason: z.literal('completed'),
    checkpointStage: z.literal('completed'),
  }),
  review: z.object({
    reviewId: z.string().min(1),
    verdict: GoalReviewVerdictSchema,
  }),
  advance: z.object({
    outcome: GoalReviewResolutionOutcomeSchema,
    nextReadyTaskId: z.string().min(1).nullable(),
  }),
});

/** @deprecated Use RunThreadGoalTestSuperviseStepRequestSchema for deterministic test support. */
export const RunThreadGoalSuperviseStepRequestSchema = RunThreadGoalTestSuperviseStepRequestSchema;

/** @deprecated Use RunThreadGoalTestSuperviseStepResponseSchema for deterministic test support. */
export const RunThreadGoalSuperviseStepResponseSchema =
  RunThreadGoalTestSuperviseStepResponseSchema;

/** App-local worker checkpoint recovery stage surfaced by recovery diagnostics. */
export const WorkerRecoveryStageSchema = z.enum([
  'preparing',
  'running_worker',
  'waiting_for_user',
  'completed',
  'failed',
  'aborted',
]);

/** Typed recovery choice surfaced for an interrupted worker state. */
export const InterruptedWorkerRecoveryChoiceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('inspect'),
    label: z.string().min(1),
    recommended: z.literal(true),
  }),
  z.object({
    kind: z.literal('retry'),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal('request_human'),
    label: z.string().min(1),
  }),
]);

/** Materialized interrupted worker state row surfaced by recovery diagnostics. */
export const InterruptedWorkerStateSchema = z.object({
  kind: z.literal('interrupted_worker_state'),
  checkpointId: z.string().min(1),
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  goalId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  stage: WorkerRecoveryStageSchema,
  iteration: z.number().int().nonnegative(),
  workerSessionId: z.string().min(1).nullable(),
  contextDigest: z.string().min(1).nullable(),
  contextAssembly: GoalStepContextAssemblySchema.nullable(),
  stopReason: StopReasonSchema.nullable(),
  diagnosticsSummary: z.string().min(1).nullable(),
  replayInstruction: z.literal(false),
  choices: z.array(InterruptedWorkerRecoveryChoiceSchema).min(1).max(10),
  materializedAt: z.string().min(1),
  sourceUpdatedAt: z.string().min(1),
});

/** Response payload listing materialized interrupted worker states. */
export const ListInterruptedWorkerStatesResponseSchema = z.object({
  items: z.array(InterruptedWorkerStateSchema),
});

/** Request body for releasing one authoritatively interrupted worker attempt for later retry. */
export const RetryInterruptedWorkerCheckpointRequestSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .strict();

/** Response payload returned after retrying one interrupted worker checkpoint. */
export const RetryInterruptedWorkerCheckpointResponseSchema = z.object({
  outcome: z.literal('released_for_retry'),
  turnId: z.string().min(1),
});

/** Response payload returned after retrying one denied scheduler admission. */
export const RetrySchedulerAdmissionResponseSchema = z.object({
  retried: z.boolean(),
});

/** Response payload returned after cancelling one scheduler admission. */
export const CancelSchedulerAdmissionResponseSchema = z.object({
  cancelled: z.boolean(),
});

/** Product-safe scheduler admission status returned by App API read models. */
export const SchedulerAdmissionStatusSchema = z.enum(['queued', 'denied']);

/** Product-safe scheduler admission priority class returned by App API read models. */
export const SchedulerAdmissionPriorityClassSchema = z.enum([
  'interactive',
  'automation',
  'maintenance',
]);

/** Product-safe typed scheduler admission denial reason. */
export const SchedulerAdmissionDenialReasonSchema = z.enum([
  'queue-full',
  'policy-cap',
  'no-compatible-pool',
  'no-healthy-target',
  'invalid-request',
]);

/** Workspace-filtered scheduler admission read model. */
export const SchedulerAdmissionReadModelSchema = z.object({
  queueEntryId: z.string().min(1),
  requestId: z.string().min(1).nullable(),
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  requestedAgentId: z.string().min(1),
  profileRef: z.string().min(1),
  priorityClass: SchedulerAdmissionPriorityClassSchema,
  enqueuedAt: TimestampSchema,
  effectivePriorityAt: TimestampSchema,
  firstCapDeferredAt: TimestampSchema.nullable(),
  requiredPoolConstraints: z.array(z.string().min(1)),
  status: SchedulerAdmissionStatusSchema,
  denialReason: SchedulerAdmissionDenialReasonSchema.nullable(),
  queuePosition: z.number().int().positive().nullable(),
});

/** Response payload listing workspace-filtered scheduler admissions. */
export const ListSchedulerAdmissionsResponseSchema = z.object({
  items: z.array(SchedulerAdmissionReadModelSchema),
});

/** Workspace dashboard response payload. */
export const WorkspaceDashboardResponseSchema = z.object({
  workspace: WorkspaceRecordSchema,
  counts: z.object({
    threadCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    knowledgeEntryCount: z.number().int().nonnegative(),
    providerCount: z.number().int().nonnegative(),
  }),
  defaultContext: z.object({
    modelId: z.string().min(1).nullable(),
    agentId: z.string().min(1).nullable(),
    skillIds: z.array(z.string().min(1)),
  }),
  agentHealth: z.array(
    z.object({
      agentId: z.string().min(1),
      status: z.string().min(1),
      message: z.string().nullable(),
      checkedAt: z.string().nullable(),
    })
  ),
  recentThreads: z.array(ThreadSchema),
  activeWork: z.array(WorkspaceActiveWorkSchema).default([]),
  recentCompletions: z.array(WorkspaceCompletionSchema).default([]),
  attentionNeeded: z.array(WorkspaceAttentionSchema).default([]),
});

/** Thread dashboard response payload. */
export const ThreadDashboardResponseSchema = z.object({
  thread: ThreadSchema,
  turns: z.array(ProductTurnSchema),
  artifacts: z.array(DashboardArtifactSummarySchema),
  workStatus: ThreadWorkStatusSchema,
  composer: z.object({
    disabled: z.boolean(),
    defaultModelId: z.string().min(1).nullable(),
    defaultAgentId: z.string().min(1).nullable(),
  }),
  itemLog: z.object({
    href: z.string().min(1),
  }),
});

/** Agent health refresh response payload. */
export const AgentHealthRefreshResponseSchema = z.object({
  items: z.array(
    z.object({
      agentId: z.string().min(1),
      status: z.string().min(1),
      message: z.string().nullable(),
      checkedAt: z.string().nullable(),
    })
  ),
});

/** Thread item replay response payload. */
export const ListThreadItemsResponseSchema = z.object({
  items: z.array(ItemSchema),
  nextCursor: z.string().min(1).nullable(),
});

/** Product work mode surfaced by app-level dashboard read models. */
export type ProductWorkMode = z.infer<typeof ProductWorkModeSchema>;
/** Routing decision summary returned by NanoCore app dashboards. */
export type WorkRouting = z.infer<typeof WorkRoutingSchema>;
/** Compact artifact summary shown in product work status surfaces. */
export type DashboardArtifactSummary = z.infer<typeof DashboardArtifactSummarySchema>;
/** Thread-level product work status shown above the protocol item stream. */
export type ThreadWorkStatus = z.infer<typeof ThreadWorkStatusSchema>;
/** App-local Goal Mode lifecycle status surfaced through App API read models. */
export type GoalReadModelStatus = z.infer<typeof GoalReadModelStatusSchema>;
/** App-local Goal Mode task lifecycle status surfaced through App API read models. */
export type GoalTaskReadModelStatus = z.infer<typeof GoalTaskReadModelStatusSchema>;
/** Current task summary inside a thread goal read model. */
export type ThreadGoalCurrentTask = z.infer<typeof ThreadGoalCurrentTaskSchema>;
/** Goal task counts keyed by task status. */
export type GoalTaskCounts = z.infer<typeof GoalTaskCountsSchema>;
/** Pending human attention summary for one goal read model. */
export type GoalPendingHumanAttention = z.infer<typeof GoalPendingHumanAttentionSchema>;
/** Terminal state summary for one closed goal. */
export type GoalTerminalState = z.infer<typeof GoalTerminalStateSchema>;
/** Verification evidence shown in a terminal Goal Mode summary. */
export type GoalTerminalVerificationEvidence = z.infer<
  typeof GoalTerminalVerificationEvidenceSchema
>;
/** Structured terminal summary for one closed Goal Mode run. */
export type GoalTerminalSummary = z.infer<typeof GoalTerminalSummarySchema>;
/** Thread-level Goal Mode summary read model. */
export type ThreadGoalSummary = z.infer<typeof ThreadGoalSummarySchema>;
/** Thread goal summary response payload. */
export type ThreadGoalSummaryResponse = z.infer<typeof ThreadGoalSummaryResponseSchema>;
/** Request body for starting Goal Mode from one thread. */
export type StartThreadGoalRequest = z.infer<typeof StartThreadGoalRequestSchema>;
/** Response payload returned after starting Goal Mode from one thread. */
export type StartThreadGoalResponse = z.infer<typeof StartThreadGoalResponseSchema>;
/** Request body for pausing Goal Mode at one safe thread boundary. */
export type PauseThreadGoalRequest = z.infer<typeof PauseThreadGoalRequestSchema>;
/** Response payload returned after pausing Goal Mode for one thread. */
export type PauseThreadGoalResponse = z.infer<typeof PauseThreadGoalResponseSchema>;
/** Request body for resuming Goal Mode at one safe thread boundary. */
export type ResumeThreadGoalRequest = z.infer<typeof ResumeThreadGoalRequestSchema>;
/** Response payload returned after resuming Goal Mode for one thread. */
export type ResumeThreadGoalResponse = z.infer<typeof ResumeThreadGoalResponseSchema>;
/** Request body for submitting steering to an active Goal Mode thread. */
export type SubmitThreadGoalSteeringRequest = z.infer<typeof SubmitThreadGoalSteeringRequestSchema>;
/** Response payload returned after submitting Goal Mode steering. */
export type SubmitThreadGoalSteeringResponse = z.infer<
  typeof SubmitThreadGoalSteeringResponseSchema
>;
/** Request body for converting terminal Goal steering into Thread follow-up history. */
export type ConvertGoalSteeringToFollowUpRequest = z.infer<
  typeof ConvertGoalSteeringToFollowUpRequestSchema
>;
/** Response payload after converting terminal Goal steering into Thread follow-up history. */
export type ConvertGoalSteeringToFollowUpResponse = z.infer<
  typeof ConvertGoalSteeringToFollowUpResponseSchema
>;
/** Request body for cancelling terminal Goal steering. */
export type CancelGoalSteeringRequest = z.infer<typeof CancelGoalSteeringRequestSchema>;
/** Response payload after cancelling terminal Goal steering. */
export type CancelGoalSteeringResponse = z.infer<typeof CancelGoalSteeringResponseSchema>;
/** Resource reference selected by a Goal Mode plan task. */
export type ThreadGoalPlanTaskResource = z.infer<typeof ThreadGoalPlanTaskResourceSchema>;
/** Expected output from one Goal Mode plan task. */
export type ThreadGoalPlanExpectedArtifact = z.infer<typeof ThreadGoalPlanExpectedArtifactSchema>;
/** Verification check proposed for one Goal Mode plan task. */
export type ThreadGoalPlanVerificationCheck = z.infer<typeof ThreadGoalPlanVerificationCheckSchema>;
/** Human review policy proposed for one Goal Mode plan task. */
export type ThreadGoalPlanReviewPolicy = z.infer<typeof ThreadGoalPlanReviewPolicySchema>;
/** One task proposed by a Goal Mode plan. */
export type ThreadGoalPlanTask = z.infer<typeof ThreadGoalPlanTaskSchema>;
/** Reviewable Goal Mode plan payload exchanged by App API routes. */
export type ThreadGoalPlan = z.infer<typeof ThreadGoalPlanSchema>;
/** Request body for creating one Goal Mode plan. */
export type CreateThreadGoalPlanRequest = z.infer<typeof CreateThreadGoalPlanRequestSchema>;
/** Response payload returned after creating a Goal Mode plan. */
export type CreateThreadGoalPlanResponse = z.infer<typeof CreateThreadGoalPlanResponseSchema>;
/** Request body for approving one Goal Mode plan. */
export type ApproveThreadGoalPlanRequest = z.infer<typeof ApproveThreadGoalPlanRequestSchema>;
/** Ready task summary returned after approving one Goal Mode plan. */
export type ApprovedThreadGoalTask = z.infer<typeof ApprovedThreadGoalTaskSchema>;
/** Response payload returned after approving one Goal Mode plan. */
export type ApproveThreadGoalPlanResponse = z.infer<typeof ApproveThreadGoalPlanResponseSchema>;
/** Request body for asking Goal Mode to revise the active plan draft. */
export type ReviseThreadGoalPlanRequest = z.infer<typeof ReviseThreadGoalPlanRequestSchema>;
/** Response payload returned after requesting Goal Mode plan revisions. */
export type ReviseThreadGoalPlanResponse = z.infer<typeof ReviseThreadGoalPlanResponseSchema>;
/** Request body for running one real bounded Goal Mode worker step. */
export type RunThreadGoalStepRequest = z.infer<typeof RunThreadGoalStepRequestSchema>;
/** Response payload returned after running one real bounded Goal Mode worker step. */
export type RunThreadGoalStepResponse = z.infer<typeof RunThreadGoalStepResponseSchema>;
/** Request body for running one deterministic Goal Mode supervise step. */
export type RunThreadGoalSuperviseStepRequest = z.infer<
  typeof RunThreadGoalSuperviseStepRequestSchema
>;
/** Response payload returned after running one deterministic Goal Mode supervise step. */
export type RunThreadGoalSuperviseStepResponse = z.infer<
  typeof RunThreadGoalSuperviseStepResponseSchema
>;
/** Request body for running one deterministic Goal Mode test supervise step. */
export type RunThreadGoalTestSuperviseStepRequest = z.infer<
  typeof RunThreadGoalTestSuperviseStepRequestSchema
>;
/** Response payload returned after running one deterministic Goal Mode test supervise step. */
export type RunThreadGoalTestSuperviseStepResponse = z.infer<
  typeof RunThreadGoalTestSuperviseStepResponseSchema
>;
/** App-local worker checkpoint recovery stage surfaced by recovery diagnostics. */
export type WorkerRecoveryStage = z.infer<typeof WorkerRecoveryStageSchema>;
/** Materialized interrupted worker state row surfaced by recovery diagnostics. */
export type InterruptedWorkerState = z.infer<typeof InterruptedWorkerStateSchema>;
/** Response payload listing materialized interrupted worker states. */
export type ListInterruptedWorkerStatesResponse = z.infer<
  typeof ListInterruptedWorkerStatesResponseSchema
>;
/** Request body for releasing one authoritatively interrupted worker attempt for later retry. */
export type RetryInterruptedWorkerCheckpointRequest = z.infer<
  typeof RetryInterruptedWorkerCheckpointRequestSchema
>;
/** Stable result returned after releasing one authoritatively interrupted worker attempt. */
export type RetryInterruptedWorkerCheckpointResponse = z.infer<
  typeof RetryInterruptedWorkerCheckpointResponseSchema
>;

/** Response payload returned after retrying one denied scheduler admission. */
export type RetrySchedulerAdmissionResponse = z.infer<typeof RetrySchedulerAdmissionResponseSchema>;

/** Response payload returned after cancelling one scheduler admission. */
export type CancelSchedulerAdmissionResponse = z.infer<
  typeof CancelSchedulerAdmissionResponseSchema
>;
/** Workspace-filtered scheduler admission read model. */
export type SchedulerAdmissionReadModel = z.infer<typeof SchedulerAdmissionReadModelSchema>;
/** Response payload listing workspace-filtered scheduler admissions. */
export type ListSchedulerAdmissionsResponse = z.infer<typeof ListSchedulerAdmissionsResponseSchema>;
/** Workspace dashboard response payload. */
export type WorkspaceDashboardResponse = z.infer<typeof WorkspaceDashboardResponseSchema>;
/** Thread dashboard response payload. */
export type ThreadDashboardResponse = z.infer<typeof ThreadDashboardResponseSchema>;
/** Agent health refresh response payload. */
export type AgentHealthRefreshResponse = z.infer<typeof AgentHealthRefreshResponseSchema>;
/** Thread item replay response payload. */
export type ListThreadItemsResponse = z.infer<typeof ListThreadItemsResponseSchema>;
