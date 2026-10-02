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
import { ApprovalEffectPreviewSchema } from './pending-request.js';
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

/** Derived initiating-request summary from one fully verified worker Context Package trace. */
export const ThreadTaskInputSchema = z
  .object({
    itemId: z.string().min(1),
    objective: z.string().min(1),
  })
  .strict();

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

/** Product-safe context assembly shared by ordinary Task recovery. */
export const WorkerCheckpointContextAssemblySchema = z.object({
  contextDigest: z.string().min(1),
  contextRefs: z.array(TaskModeContextRefSchema).min(1).max(50),
});

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
  contextAssembly: WorkerCheckpointContextAssemblySchema.nullable(),
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
  profileRef: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
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

/** Viewer-authorized navigation over current or latest conversation activity. */
export const ConversationNavigationResponseSchema = z.object({
  items: z.array(
    z.object({
      thread: ThreadSchema,
      activity: z.enum(['chat', 'task', 'goal', 'unknown']),
      state: z.enum(['working', 'needs-you', 'idle']),
      lastActivityAt: TimestampSchema,
    })
  ),
});

/** Navigation activity is a projection, never a durable Thread kind or read receipt. */
export type ConversationNavigationResponse = z.infer<typeof ConversationNavigationResponseSchema>;

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
    agentId: z.string().min(1).nullable(),
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

/** Maximum outward runtime activity entries projected for one Turn. */
export const THREAD_RUNTIME_ACTIVITY_MAX_ENTRIES = 50;

/** Maximum outward text characters per activity entry; retained bodies remain complete. */
export const THREAD_RUNTIME_ACTIVITY_MAX_TEXT_CHARACTERS = 1000;

/** Thread dashboard response payload. */
export const ThreadDashboardResponseSchema = z.object({
  viewerUserId: z.string().min(1).nullable(),
  participants: z.array(
    z
      .object({
        kind: z.enum(['user', 'agent', 'automation', 'integration', 'system']),
        id: z.string().min(1),
        displayName: z.string().min(1),
      })
      .strict()
  ),
  thread: ThreadSchema,
  turns: z.array(ProductTurnSchema),
  artifacts: z.array(DashboardArtifactSummarySchema),
  workStatus: ThreadWorkStatusSchema,
  composer: z.object({
    disabled: z.boolean(),
    defaultAgentId: z.string().min(1).nullable(),
  }),
  itemLog: z.object({
    href: z.string().min(1),
  }),
  taskInputs: z.array(ThreadTaskInputSchema),
  /** Authoritative request state; Items remain historical communication. */
  pendingRequests: z
    .array(
      z.object({
        requestId: z.string().min(1),
        approvalEffect: ApprovalEffectPreviewSchema.optional(),
        canRespond: z.boolean().optional(),
        state: z.enum(['pending', 'resolved', 'ended', 'inspect-only']),
        resolution: z.enum(['granted', 'denied', 'answered']).nullable(),
        ending: z.enum(['withdrawn', 'invalidated']).nullable(),
        disposition: z
          .enum(['approved-executed', 'denied-not-executed', 'execution-error', 'outcome-unknown'])
          .nullable(),
      })
    )
    .optional(),
  /** Lossy outward activity, never retained bodies, execution authority, or proof of completeness. */
  runtimeActivity: z
    .array(
      z
        .object({
          turnId: z.string().min(1),
          contentCapture: z.enum(['off', 'on', 'unknown']),
          coverage: z.enum(['collecting', 'partial', 'unavailable']),
          entries: z
            .array(
              z
                .object({
                  sequence: z.number().int().nonnegative(),
                  observedAt: z.iso.datetime(),
                  kind: z.enum(['child-started', 'progress', 'result', 'failure']),
                  label: z.string().min(1).max(80).optional(),
                  text: z.string().max(THREAD_RUNTIME_ACTIVITY_MAX_TEXT_CHARACTERS).optional(),
                  textTruncated: z.boolean(),
                })
                .strict()
            )
            .max(THREAD_RUNTIME_ACTIVITY_MAX_ENTRIES),
          omittedEntryCount: z.number().int().nonnegative(),
        })
        .strict()
    )
    .optional(),
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
/** Derived initiating-request summary on the authorized Thread dashboard. */
export type ThreadTaskInput = z.infer<typeof ThreadTaskInputSchema>;
/** Agent health refresh response payload. */
export type AgentHealthRefreshResponse = z.infer<typeof AgentHealthRefreshResponseSchema>;
/** Thread item replay response payload. */
export type ListThreadItemsResponse = z.infer<typeof ListThreadItemsResponseSchema>;
