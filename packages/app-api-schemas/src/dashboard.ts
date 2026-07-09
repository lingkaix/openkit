import {
  AgentSandboxSummarySchema,
  AgentSessionStatusSchema,
  ArtifactSchema,
  ItemSchema,
  StopReasonSchema,
  ThreadSchema,
  TimestampSchema,
  TurnSchema,
  TurnStatusSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { MaterializedWorkspaceRootSchema } from './runtime-config.js';
import { TaskDelegationDecisionSchema, TaskModeContextRefSchema } from './task-mode.js';

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
  'verifying',
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
  'needs_revision',
  'completed',
  'blocked',
  'failed',
  'skipped',
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
  needsRevision: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
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
  skippedTaskIds: z.array(z.string().min(1)).max(100),
  blockedTaskIds: z.array(z.string().min(1)).max(100),
  artifactIds: z.array(z.string().min(1)).max(100),
  verificationEvidence: z.array(GoalTerminalVerificationEvidenceSchema).max(100),
  risks: z.array(z.string().min(1).max(1_000)).max(50),
  suggestedNextWork: z.array(z.string().min(1).max(1_000)).max(50),
});

/** Steering summary for active Goal Mode user input. */
export const GoalSteeringSummarySchema = z.object({
  pendingSteeringCount: z.number().int().nonnegative(),
  pendingFollowUpCount: z.number().int().nonnegative(),
  appliedSteeringCount: z.number().int().nonnegative(),
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
  steering: GoalSteeringSummarySchema,
  updatedAt: z.string().min(1),
});

/** Thread goal summary response payload. */
export const ThreadGoalSummaryResponseSchema = z.object({
  goal: ThreadGoalSummarySchema.nullable(),
});

/** Request body for starting Goal Mode from one thread. */
export const StartThreadGoalRequestSchema = z.object({
  objective: z.string().min(1),
  title: z.string().min(1).optional(),
});

/** Response payload returned after starting Goal Mode from one thread. */
export const StartThreadGoalResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
  objectiveItemId: z.string().min(1),
});

/** Response payload returned after pausing Goal Mode for one thread. */
export const PauseThreadGoalResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
});

/** Response payload returned after resuming Goal Mode for one thread. */
export const ResumeThreadGoalResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
});

/** Request body for submitting steering to an active Goal Mode thread. */
export const SubmitThreadGoalSteeringRequestSchema = z.object({
  requestId: z.string().min(1),
  message: z.string().min(1).max(4_000),
});

/** Response payload returned after submitting Goal Mode steering. */
export const SubmitThreadGoalSteeringResponseSchema = z.object({
  state: z.enum(['queued', 'blocked']),
  goal: ThreadGoalSummarySchema,
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

/** Human or automated review policy proposed for one Goal Mode plan task. */
export const ThreadGoalPlanReviewPolicySchema = z.object({
  required: z.boolean(),
  reviewers: z
    .array(z.enum(['human', 'internal', 'worker']))
    .min(1)
    .max(3),
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
});

/** Response payload returned after creating a Goal Mode plan. */
export const CreateThreadGoalPlanResponseSchema = z.object({
  status: z.literal('awaiting_plan_approval'),
  goal: ThreadGoalSummarySchema,
  planItemId: z.string().min(1),
  planner: GoalPlanPlannerSummarySchema,
  plan: ThreadGoalPlanSchema,
});

/** Request body for approving one Goal Mode plan. */
export const ApproveThreadGoalPlanRequestSchema = z.object({
  planItemId: z.string().min(1),
  plan: ThreadGoalPlanSchema,
});

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
export const ReviseThreadGoalPlanRequestSchema = z.object({
  requestId: z.string().min(1).optional(),
  revision: z.string().min(1).max(4_000),
});

/** Response payload returned after requesting Goal Mode plan revisions. */
export const ReviseThreadGoalPlanResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
  revisionItemId: z.string().min(1),
  startsWorkerTurn: z.literal(false),
});

/** Follow-up queue drain policy for one real Goal Mode worker step. */
export const GoalStepFollowUpDrainModeSchema = z.enum(['one_at_a_time', 'all']);

/** Review policy override requested for one real Goal Mode worker step. */
export const GoalStepReviewPolicyOverrideSchema = z.enum(['human', 'auto', 'none']);

/** Product-facing pending attention returned by one real Goal Mode worker step. */
export const GoalStepPendingAttentionSchema = z.object({
  kind: z.enum(['review', 'user_input', 'blocked', 'failed', 'interrupted']),
  reason: z.string().min(1),
  itemId: z.string().min(1).nullable(),
});

/** Product-safe context assembly summary for one bounded worker step. */
export const GoalStepContextAssemblySchema = z.object({
  contextDigest: z.string().min(1),
  contextRefs: z.array(TaskModeContextRefSchema).min(1).max(50),
  repositoryResourceId: z.string().min(1),
  steeringMessageCount: z.number().int().nonnegative(),
  followUpInputCount: z.number().int().nonnegative(),
});

/** App-local worker checkpoint stage returned by one real Goal Mode worker step. */
export const GoalStepCheckpointStageSchema = z.enum([
  'preparing',
  'running_worker',
  'waiting_for_user',
  'reviewing',
  'verifying',
  'saving',
  'recovering',
  'completed',
  'failed',
  'aborted',
]);

/** Request body for running one real bounded Goal Mode worker step. */
export const RunThreadGoalStepRequestSchema = z.object({
  requestId: z.string().min(1),
  followUpDrainMode: GoalStepFollowUpDrainModeSchema.optional(),
  reviewPolicyOverride: GoalStepReviewPolicyOverrideSchema.optional(),
});

/** Response payload returned after running one real bounded Goal Mode worker step. */
export const RunThreadGoalStepResponseSchema = z.object({
  goal: ThreadGoalSummarySchema,
  worker: z.object({
    turnId: z.string().min(1),
    stopReason: StopReasonSchema.nullable(),
    checkpointStage: GoalStepCheckpointStageSchema,
    workerSessionId: z.string().min(1).nullable(),
    evidence: z.object({
      itemIds: z.array(z.string().min(1)).max(100),
      artifactIds: z.array(z.string().min(1)).max(100),
    }),
  }),
  contextAssembly: GoalStepContextAssemblySchema,
  coordinator: TaskDelegationDecisionSchema,
  decision: z.object({
    schemaVersion: z.literal(1),
    mode: z.literal('goal'),
    sourceAgentId: z.literal('worker-coordinator'),
    requestId: z.string().min(1),
    outcome: z.enum(['continue', 'review', 'ask_user', 'block', 'abort', 'complete']),
    shouldStop: z.boolean(),
    stopReason: StopReasonSchema,
    rationale: z.string().min(1),
    contextRefs: z.array(TaskModeContextRefSchema).min(1).max(50),
    evidence: z.object({
      itemIds: z.array(z.string().min(1)).max(100),
      artifactIds: z.array(z.string().min(1)).max(100),
    }),
  }),
  pendingAttention: GoalStepPendingAttentionSchema.nullable(),
});

/** Request body for running one deterministic Goal Mode supervise step. */
export const RunThreadGoalTestSuperviseStepRequestSchema = z.object({
  verdict: z
    .enum(['accept', 'refine', 'retry', 'decompose', 'ask_user', 'block', 'abort'])
    .default('accept'),
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
    verdict: z.enum(['accept', 'refine', 'retry', 'decompose', 'ask_user', 'block', 'abort']),
  }),
  advance: z.object({
    outcome: z.enum([
      'complete_next_task',
      'complete_goal',
      'continue',
      'retry',
      'needs_revision',
      'decompose',
      'awaiting_human',
      'blocked',
      'aborted',
    ]),
    nextTaskId: z.string().min(1).nullable(),
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
  'reviewing',
  'verifying',
  'saving',
  'recovering',
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
    kind: z.literal('record_terminal'),
    label: z.string().min(1),
    allowedTerminalStages: z.array(z.enum(['completed', 'failed', 'aborted'])).length(3),
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

/** Pending user turn row surfaced by recovery diagnostics. */
export const RecoveryPendingUserTurnSchema = z.object({
  pendingTurnId: z.string().min(1),
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  requestId: z.string().min(1),
  contentItemId: z.string().min(1).nullable(),
  contentDigest: z.string().min(1).nullable(),
  queueMode: z.enum(['follow_up', 'safe_point_steering']),
  receivedAt: z.string().min(1),
  createdAt: z.string().min(1),
});

/** Response payload returned after creating deterministic recovery state. */
export const CreateInterruptedRecoveryStateResponseSchema = z.object({
  checkpoint: z.object({
    checkpointId: z.string().min(1),
    turnId: z.string().min(1),
    stage: WorkerRecoveryStageSchema,
  }),
  pendingUserTurn: RecoveryPendingUserTurnSchema,
});

/** Response payload listing materialized interrupted worker states. */
export const ListInterruptedWorkerStatesResponseSchema = z.object({
  items: z.array(InterruptedWorkerStateSchema),
});

/** Response payload listing pending user turns for one thread. */
export const ListRecoveryPendingUserTurnsResponseSchema = z.object({
  items: z.array(RecoveryPendingUserTurnSchema),
});

/** Response payload returned after pending user turn cancellation is attempted. */
export const CancelRecoveryPendingUserTurnResponseSchema = z.object({
  cancelled: z.boolean(),
});

/** Response payload returned after pending user turn follow-up conversion is attempted. */
export const ConvertRecoveryPendingUserTurnToFollowUpResponseSchema = z.object({
  converted: z.boolean(),
  pendingUserTurn: RecoveryPendingUserTurnSchema.nullable(),
});

/** Response payload returned after pending user turn interrupt promotion is attempted. */
export const PromoteRecoveryPendingUserTurnToInterruptResponseSchema = z.object({
  promoted: z.boolean(),
  turn: TurnSchema.nullable(),
});

/** Request body for editing one pending user turn item. */
export const EditRecoveryPendingUserTurnRequestSchema = z.object({
  text: z.string().min(1).max(20_000),
});

/** Response payload returned after pending user turn edit is attempted. */
export const EditRecoveryPendingUserTurnResponseSchema = z.object({
  edited: z.boolean(),
  item: z
    .object({
      id: z.string().min(1),
      text: z.string().min(1),
    })
    .nullable(),
});

/** Request body for clearing one interrupted worker checkpoint after terminal save. */
export const ClearInterruptedWorkerCheckpointRequestSchema = z.object({
  terminalStage: z.enum(['completed', 'failed', 'aborted']),
});

/** Response payload returned after checkpoint cleanup is attempted. */
export const ClearInterruptedWorkerCheckpointResponseSchema = z.object({
  cleared: z.boolean(),
});

/** Response payload returned after retrying one interrupted worker checkpoint. */
export const RetryInterruptedWorkerCheckpointResponseSchema = z.object({
  retried: z.boolean(),
  turn: TurnSchema.nullable(),
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

/** Product-safe live worker control summary for one backend session. */
export const AgentSessionBackendControlSummarySchema = z.object({
  heartbeat: z
    .object({
      status: z.enum([
        'starting',
        'running',
        'idle',
        'awaiting_command',
        'stopping',
        'completed',
        'failed',
      ]),
      sequence: z.number().int().nonnegative(),
      lastHeartbeatAt: z.string().min(1),
    })
    .nullable(),
  artifactNoticeCount: z.number().int().nonnegative(),
  queuedCommandCount: z.number().int().nonnegative(),
  deliveredCommandCount: z.number().int().nonnegative(),
  terminalResultCount: z.number().int().nonnegative(),
  lastTerminalExitCode: z.number().int().nullable(),
  lastTerminalCompletedAt: z.string().min(1).nullable(),
});

/** Agent session read model enriched with NanoCore app-local runtime state. */
export const AgentSessionBackendSummarySchema = z.object({
  kind: z.enum([
    'host',
    'openshell',
    'docker',
    'kubernetes',
    'vm',
    'managed-sandbox',
    'custom',
    'unknown',
  ]),
  health: z.enum(['ready', 'unavailable', 'unknown', 'not-applicable']),
  controlMode: z
    .enum(['transcript-sink', 'backend-relay', 'direct-nanocore', 'sidecar', 'stdio', 'disabled'])
    .nullable(),
  control: AgentSessionBackendControlSummarySchema.nullable().default(null),
  gatewayName: z.string().min(1).nullable(),
  gatewayEndpoint: z.string().min(1).nullable(),
  version: z.string().min(1).nullable(),
  sandboxName: z.string().min(1).nullable(),
});

/** Agent session read model enriched with NanoCore app-local runtime state. */
export const AgentSessionReadModelSchema = z.object({
  id: z.string().min(1),
  status: AgentSessionStatusSchema,
  message: z.string().min(1).nullable(),
  configVersion: z.number().int().positive().nullable(),
  workspaceRoots: z.array(MaterializedWorkspaceRootSchema),
  stale: z.boolean(),
  sandboxSummary: AgentSandboxSummarySchema.nullable().default(null),
  backend: AgentSessionBackendSummarySchema.nullable().default(null),
});

/** Request payload for queueing a terminal command in one active agent session. */
export const QueueAgentSessionTerminalCommandRequestSchema = z.object({
  requestId: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).nullable().default(null),
});

/** Response payload returned after queueing a terminal command. */
export const QueueAgentSessionTerminalCommandResponseSchema = z.object({
  command: z.object({
    commandId: z.string().min(1),
    kind: z.literal('terminal-command'),
    sequence: z.number().int().nonnegative(),
    queuedAt: z.string().min(1),
    deliveredAt: z.string().min(1).nullable(),
    argv: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).nullable(),
  }),
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
  activeSession: AgentSessionReadModelSchema.nullable(),
  turns: z.array(TurnSchema),
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
  sessions: z.array(AgentSessionReadModelSchema),
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
/** Steering summary for active Goal Mode user input. */
export type GoalSteeringSummary = z.infer<typeof GoalSteeringSummarySchema>;
/** Thread-level Goal Mode summary read model. */
export type ThreadGoalSummary = z.infer<typeof ThreadGoalSummarySchema>;
/** Thread goal summary response payload. */
export type ThreadGoalSummaryResponse = z.infer<typeof ThreadGoalSummaryResponseSchema>;
/** Request body for starting Goal Mode from one thread. */
export type StartThreadGoalRequest = z.infer<typeof StartThreadGoalRequestSchema>;
/** Response payload returned after starting Goal Mode from one thread. */
export type StartThreadGoalResponse = z.infer<typeof StartThreadGoalResponseSchema>;
/** Response payload returned after pausing Goal Mode for one thread. */
export type PauseThreadGoalResponse = z.infer<typeof PauseThreadGoalResponseSchema>;
/** Response payload returned after resuming Goal Mode for one thread. */
export type ResumeThreadGoalResponse = z.infer<typeof ResumeThreadGoalResponseSchema>;
/** Request body for submitting steering to an active Goal Mode thread. */
export type SubmitThreadGoalSteeringRequest = z.infer<typeof SubmitThreadGoalSteeringRequestSchema>;
/** Response payload returned after submitting Goal Mode steering. */
export type SubmitThreadGoalSteeringResponse = z.infer<
  typeof SubmitThreadGoalSteeringResponseSchema
>;
/** Resource reference selected by a Goal Mode plan task. */
export type ThreadGoalPlanTaskResource = z.infer<typeof ThreadGoalPlanTaskResourceSchema>;
/** Expected output from one Goal Mode plan task. */
export type ThreadGoalPlanExpectedArtifact = z.infer<typeof ThreadGoalPlanExpectedArtifactSchema>;
/** Verification check proposed for one Goal Mode plan task. */
export type ThreadGoalPlanVerificationCheck = z.infer<typeof ThreadGoalPlanVerificationCheckSchema>;
/** Human or automated review policy proposed for one Goal Mode plan task. */
export type ThreadGoalPlanReviewPolicy = z.infer<typeof ThreadGoalPlanReviewPolicySchema>;
/** One task proposed by a Goal Mode plan. */
export type ThreadGoalPlanTask = z.infer<typeof ThreadGoalPlanTaskSchema>;
/** Reviewable Goal Mode plan payload exchanged by App API routes. */
export type ThreadGoalPlan = z.infer<typeof ThreadGoalPlanSchema>;
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
/** Follow-up queue drain policy for one real Goal Mode worker step. */
export type GoalStepFollowUpDrainMode = z.infer<typeof GoalStepFollowUpDrainModeSchema>;
/** Review policy override requested for one real Goal Mode worker step. */
export type GoalStepReviewPolicyOverride = z.infer<typeof GoalStepReviewPolicyOverrideSchema>;
/** Product-facing pending attention returned by one real Goal Mode worker step. */
export type GoalStepPendingAttention = z.infer<typeof GoalStepPendingAttentionSchema>;
/** App-local worker checkpoint stage returned by one real Goal Mode worker step. */
export type GoalStepCheckpointStage = z.infer<typeof GoalStepCheckpointStageSchema>;
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
/** Pending user turn row surfaced by recovery diagnostics. */
export type RecoveryPendingUserTurn = z.infer<typeof RecoveryPendingUserTurnSchema>;
/** Response payload returned after creating deterministic recovery state. */
export type CreateInterruptedRecoveryStateResponse = z.infer<
  typeof CreateInterruptedRecoveryStateResponseSchema
>;
/** Response payload listing materialized interrupted worker states. */
export type ListInterruptedWorkerStatesResponse = z.infer<
  typeof ListInterruptedWorkerStatesResponseSchema
>;
/** Response payload listing pending user turns for one thread. */
export type ListRecoveryPendingUserTurnsResponse = z.infer<
  typeof ListRecoveryPendingUserTurnsResponseSchema
>;
/** Response payload returned after pending user turn cancellation is attempted. */
export type CancelRecoveryPendingUserTurnResponse = z.infer<
  typeof CancelRecoveryPendingUserTurnResponseSchema
>;
/** Response payload returned after pending user turn follow-up conversion is attempted. */
export type ConvertRecoveryPendingUserTurnToFollowUpResponse = z.infer<
  typeof ConvertRecoveryPendingUserTurnToFollowUpResponseSchema
>;
/** Response payload returned after pending user turn interrupt promotion is attempted. */
export type PromoteRecoveryPendingUserTurnToInterruptResponse = z.infer<
  typeof PromoteRecoveryPendingUserTurnToInterruptResponseSchema
>;
/** Request body for editing one pending user turn item. */
export type EditRecoveryPendingUserTurnRequest = z.infer<
  typeof EditRecoveryPendingUserTurnRequestSchema
>;
/** Response payload returned after pending user turn edit is attempted. */
export type EditRecoveryPendingUserTurnResponse = z.infer<
  typeof EditRecoveryPendingUserTurnResponseSchema
>;
/** Request body for clearing one interrupted worker checkpoint after terminal save. */
export type ClearInterruptedWorkerCheckpointRequest = z.infer<
  typeof ClearInterruptedWorkerCheckpointRequestSchema
>;
/** Response payload returned after checkpoint cleanup is attempted. */
export type ClearInterruptedWorkerCheckpointResponse = z.infer<
  typeof ClearInterruptedWorkerCheckpointResponseSchema
>;

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
/** Product-safe live worker control summary for one backend session. */
export type AgentSessionBackendControlSummary = z.infer<
  typeof AgentSessionBackendControlSummarySchema
>;
/** Request payload for queueing a terminal command in one active agent session. */
export type QueueAgentSessionTerminalCommandRequest = z.infer<
  typeof QueueAgentSessionTerminalCommandRequestSchema
>;
/** Response payload returned after queueing a terminal command. */
export type QueueAgentSessionTerminalCommandResponse = z.infer<
  typeof QueueAgentSessionTerminalCommandResponseSchema
>;
/** Workspace dashboard response payload. */
export type WorkspaceDashboardResponse = z.infer<typeof WorkspaceDashboardResponseSchema>;
/** Thread dashboard response payload. */
export type ThreadDashboardResponse = z.infer<typeof ThreadDashboardResponseSchema>;
/** Agent health refresh response payload. */
export type AgentHealthRefreshResponse = z.infer<typeof AgentHealthRefreshResponseSchema>;
/** Thread item replay response payload. */
export type ListThreadItemsResponse = z.infer<typeof ListThreadItemsResponseSchema>;
