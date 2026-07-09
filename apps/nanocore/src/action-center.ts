import {
  type HumanAttentionAction,
  type HumanAttentionRow,
  ListHumanAttentionResponseSchema,
} from '@openkit/app-api-schemas';
import type { StopReason } from '@openkit/protocol';
import type { FsStore } from './lib/store.js';
import { POLICY_ESCALATION_CAUSATION_PREFIX } from './policy/approval-gates.js';
import { listGoalReviewRecordsForTask } from './runtime/goal-review-records.js';
import { type GoalRecord, listGoalRecordsForThread, listGoalTasks } from './runtime/goal-store.js';
import { listPendingUserTurns } from './runtime/pending-user-turns.js';
import { listWorkerControlRejectedEvidenceForWorkspace } from './runtime/worker-control-rejected-evidence.js';
import { materializeInterruptedWorkerStates } from './runtime/worker-recovery.js';
import { listWorkspaceReconciliationRecords } from './runtime/workspace-reconciliation-records.js';
import { listWorkspaceSyncReviews } from './runtime/workspace-sync-records.js';
import {
  listSchedulerAdmissionEntriesForWorkspace,
  listSchedulerOrphanWorkerEvidenceForWorkspace,
  type SchedulerAdmissionEntryRecord,
  type SchedulerOrphanWorkerEvidenceRecord,
} from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

type StoreItem = ReturnType<FsStore['listAllItems']>[number];
type ApprovalRequestStoreItem = Extract<StoreItem, { type: 'approval-request' }>;
type ApprovalDecisionStoreItem = Extract<StoreItem, { type: 'approval-decision' }>;
type StatusStoreItem = Extract<StoreItem, { type: 'status' }>;
type UserInputRequestStoreItem = Extract<StoreItem, { type: 'user-input-request' }>;
type UserInputResponseStoreItem = Extract<StoreItem, { type: 'user-input-response' }>;

/**
 * Input used to build unified Human Attention rows.
 */
export interface BuildHumanAttentionRowsInput {
  /** Request-scoped workspace store. */
  store: FsStore;
  /** Optional Core database handles for app-local runtime rows. */
  coreDb?: CoreDb | undefined;
  /** Optional workspace database handles for workspace-owned rows. */
  workspaceDb?: WorkspaceDb | undefined;
  /** Workspace id to project. */
  workspaceId: string;
}

/**
 * Builds the unified Human Attention Action Center response for one workspace.
 *
 * @param input Projection dependencies and workspace scope.
 * @returns Strict App API response payload.
 */
export function buildHumanAttentionResponse(input: BuildHumanAttentionRowsInput): unknown {
  return ListHumanAttentionResponseSchema.parse({
    items: buildHumanAttentionRows(input),
  });
}

/**
 * Builds unified Human Attention rows for every currently backed NanoCore source.
 *
 * @param input Projection dependencies and workspace scope.
 * @returns Human Attention rows in deterministic creation order.
 */
export function buildHumanAttentionRows(input: BuildHumanAttentionRowsInput): HumanAttentionRow[] {
  input.store.getWorkspace(input.workspaceId);

  const artifactRows = artifactReviewRows(input.store, input.workspaceId);
  const rows = [
    ...approvalRows(input.store, input.workspaceId),
    ...questionRows(input.store, input.workspaceId),
    ...policyEscalationRows(input.store, input.workspaceId),
    ...runtimeRows(input),
    ...agentReadinessRows(input.store, input.workspaceId),
    ...artifactRows,
    ...durableWorkspaceReviewRows(input, artifactRows),
    ...knowledgeReviewRows(input.store, input.workspaceId),
  ];

  return rows.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

/**
 * Projects pending durable staged workspace reviews into Action Center rows.
 *
 * @param input Projection dependencies and workspace scope.
 * @param artifactRows Already projected artifact review rows used for de-duplication.
 * @returns Durable workspace review rows that are not already represented by artifacts.
 */
function durableWorkspaceReviewRows(
  input: BuildHumanAttentionRowsInput,
  artifactRows: readonly HumanAttentionRow[]
): HumanAttentionRow[] {
  if (!input.workspaceDb) {
    return [];
  }

  const projectedArtifactIds = new Set(
    artifactRows
      .filter((row) => row.kind === 'workspace_review')
      .map((row) => row.artifactId)
      .filter((artifactId): artifactId is string => Boolean(artifactId))
  );

  return listWorkspaceSyncReviews(input.workspaceDb, input.workspaceId)
    .filter((item) => item.review.status === 'pending')
    .filter((item) => !projectedArtifactIds.has(item.artifactId))
    .map((item) => ({
      id: item.review.actionCenterRowId,
      kind: 'workspace_review',
      workspaceId: item.review.workspaceId,
      artifactId: item.artifactId,
      title: 'Review workspace changes',
      summary: item.review.riskSummary,
      severity: 'needs_input',
      createdAt: item.review.updatedAt,
      recommendedAction: 'Inspect, accept, refine, redo, reject, or defer these workspace changes.',
      source: {
        type: 'workspace_review',
        reviewId: item.review.id,
        changeSetId: item.review.changeSetId,
        artifactId: item.artifactId,
        workspaceId: item.review.workspaceId,
        status: item.review.status,
      },
      actions: durableWorkspaceReviewActions(input.workspaceId, item.review.id, item.artifactId),
    }));
}

/**
 * Returns true when one item is an approval-decision item.
 *
 * @param item Store item to inspect.
 * @returns True when the item records an approval decision.
 */
function isApprovalDecisionItem(item: StoreItem): item is ApprovalDecisionStoreItem {
  return item.type === 'approval-decision';
}

/**
 * Returns true when one item is an approval-request item.
 *
 * @param item Store item to inspect.
 * @returns True when the item requests an approval decision.
 */
function isApprovalRequestItem(item: StoreItem): item is ApprovalRequestStoreItem {
  return item.type === 'approval-request';
}

/**
 * Returns true when one item is a user-input request item.
 *
 * @param item Store item to inspect.
 * @returns True when the item asks the user for input.
 */
function isUserInputRequestItem(item: StoreItem): item is UserInputRequestStoreItem {
  return item.type === 'user-input-request';
}

/**
 * Returns true when one item is a user-input response item.
 *
 * @param item Store item to inspect.
 * @returns True when the item answers a previous user-input request.
 */
function isUserInputResponseItem(item: StoreItem): item is UserInputResponseStoreItem {
  return item.type === 'user-input-response';
}

/**
 * Returns true when one status item carries a policy escalation marker.
 *
 * @param item Store item to inspect.
 * @returns True when the item is a policy escalation row source.
 */
function isPolicyEscalationItem(item: StoreItem): item is StatusStoreItem {
  return (
    item.type === 'status' &&
    typeof item.causationId === 'string' &&
    item.causationId.startsWith(POLICY_ESCALATION_CAUSATION_PREFIX)
  );
}

/**
 * Projects policy escalation status items into blocked Action Center rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to inspect.
 * @returns Policy escalation rows.
 */
function policyEscalationRows(store: FsStore, workspaceId: string): HumanAttentionRow[] {
  return store
    .listAllItems()
    .filter((item) => item.workspaceId === workspaceId)
    .filter(isPolicyEscalationItem)
    .map((item) => {
      const thread = store.getThread(item.workspaceId, item.threadId);

      return {
        id: `policy-escalation:${item.id}`,
        kind: 'blocked_turn',
        workspaceId: item.workspaceId,
        threadId: item.threadId,
        turnId: item.turnId,
        itemId: item.id,
        title: item.title,
        summary: item.summary ?? 'A higher-authority policy decision is required.',
        severity: 'risk',
        createdAt: item.createdAt,
        recommendedAction: 'Review the escalation and decide the next policy action.',
        source: {
          type: 'protocol_item',
          itemType: item.type,
          workspaceId: item.workspaceId,
          threadId: item.threadId,
          turnId: item.turnId,
          itemId: item.id,
        },
        actions: [openThreadAction(thread.id)],
      };
    });
}

/**
 * Projects unresolved approval requests into unified rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to inspect.
 * @returns Approval rows.
 */
function approvalRows(store: FsStore, workspaceId: string): HumanAttentionRow[] {
  const items = store.listAllItems().filter((item) => item.workspaceId === workspaceId);
  const decisions = new Set(
    items.filter(isApprovalDecisionItem).map((item) => item.approvalRequestId)
  );

  return items
    .filter(isApprovalRequestItem)
    .filter((item) => !decisions.has(item.approvalRequestId))
    .map((item) => {
      const approval = store.getApproval(item.approvalRequestId);
      const thread = store.getThread(item.workspaceId, item.threadId);

      return {
        id: `approval:${approval.id}`,
        kind: 'approval',
        workspaceId: item.workspaceId,
        threadId: item.threadId,
        turnId: item.turnId,
        itemId: item.id,
        title: item.title,
        summary: item.description,
        severity: 'needs_input',
        createdAt: item.createdAt,
        recommendedAction: 'Review and respond to the approval request.',
        source: {
          type: 'approval',
          approvalRequestId: approval.id,
          workspaceId: item.workspaceId,
          threadId: item.threadId,
          turnId: item.turnId,
          itemId: item.id,
        },
        actions: [
          {
            kind: 'grant_approval',
            label: 'Approve',
            method: 'POST',
            href: `/api/approvals/${approval.id}/respond`,
          },
          {
            kind: 'deny_approval',
            label: 'Deny',
            method: 'POST',
            href: `/api/approvals/${approval.id}/respond`,
          },
          openThreadAction(thread.id),
        ],
      };
    });
}

/**
 * Projects unresolved user-input requests into unified rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to inspect.
 * @returns Question rows.
 */
function questionRows(store: FsStore, workspaceId: string): HumanAttentionRow[] {
  const items = store.listAllItems().filter((item) => item.workspaceId === workspaceId);
  const responses = new Set(
    items.filter(isUserInputResponseItem).map((item) => item.userInputRequestId)
  );

  return items
    .filter(isUserInputRequestItem)
    .filter((item) => !responses.has(item.userInputRequestId))
    .map((item) => ({
      id: `question:${item.id}`,
      kind: 'question',
      workspaceId: item.workspaceId,
      threadId: item.threadId,
      turnId: item.turnId,
      itemId: item.id,
      title: 'Answer required',
      summary: item.prompt,
      severity: 'needs_input',
      createdAt: item.createdAt,
      recommendedAction: 'Answer the question before the worker can continue.',
      source: {
        type: 'protocol_item',
        itemType: item.type,
        workspaceId: item.workspaceId,
        threadId: item.threadId,
        turnId: item.turnId,
        itemId: item.id,
      },
      actions: [
        {
          kind: 'answer_question',
          label: 'Answer',
          method: 'POST',
          href: '/api/turns',
        },
        openThreadAction(item.threadId),
      ],
    }));
}

/**
 * Projects app-local runtime rows backed by the Core database.
 *
 * @param input Projection dependencies and workspace scope.
 * @returns Runtime-backed rows.
 */
function runtimeRows(input: BuildHumanAttentionRowsInput): HumanAttentionRow[] {
  if (!input.coreDb) {
    return [];
  }

  return [
    ...schedulerAdmissionRows(input.coreDb, input.workspaceId),
    ...workerControlRejectedEvidenceRows(input.coreDb, input.workspaceId),
    ...schedulerOrphanWorkerRows(input.coreDb, input.workspaceId),
    ...(input.workspaceDb
      ? pendingInputRows(input.store, input.workspaceDb, input.workspaceId)
      : []),
    ...(input.workspaceDb ? checkpointRows(input.workspaceDb, input.workspaceId) : []),
    ...(input.workspaceDb ? workspaceRecoveryRows(input.workspaceDb, input.workspaceId) : []),
    ...(input.workspaceDb ? goalRows(input.store, input.workspaceDb, input.workspaceId) : []),
  ];
}

/**
 * Projects durable scheduler admissions into product-visible attention rows.
 *
 * @param coreDb Open server-scope Core database handle.
 * @param workspaceId Workspace id to project.
 * @returns Scheduler admission rows for queued or human-actionable denied entries.
 */
function schedulerAdmissionRows(coreDb: CoreDb, workspaceId: string): HumanAttentionRow[] {
  return listSchedulerAdmissionEntriesForWorkspace(coreDb, {
    workspaceId,
    statuses: ['queued', 'denied'],
  }).map((entry) => {
    const status = entry.status === 'denied' ? 'denied' : 'queued';

    return {
      id: `scheduler-admission:${entry.queueEntryId}`,
      kind: status === 'denied' ? 'blocked_turn' : 'pending_input',
      workspaceId: entry.workspaceId,
      threadId: entry.threadId,
      turnId: entry.turnId,
      title: schedulerAdmissionTitle(entry),
      summary: schedulerAdmissionSummary(entry),
      severity: status === 'denied' ? 'blocked' : 'info',
      createdAt: entry.enqueuedAt,
      recommendedAction:
        status === 'denied'
          ? 'Open the thread and resolve the scheduler blocker before retrying.'
          : 'Open the thread to review the queued worker turn.',
      source: {
        type: 'scheduler_admission',
        queueEntryId: entry.queueEntryId,
        status,
        denialReason: entry.denialReason ?? undefined,
        workspaceId: entry.workspaceId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        requestedAgentId: entry.requestedAgentId,
        priorityClass: entry.priorityClass,
      },
      actions: schedulerAdmissionActions(workspaceId, entry),
    };
  });
}

/**
 * Projects rejected worker-control evidence into product-visible attention rows.
 *
 * @param coreDb Open server-scope Core database handle.
 * @param workspaceId Workspace id to project.
 * @returns Worker-control rejection rows.
 */
function workerControlRejectedEvidenceRows(
  coreDb: CoreDb,
  workspaceId: string
): HumanAttentionRow[] {
  return listWorkerControlRejectedEvidenceForWorkspace(coreDb, workspaceId).map((evidence) => ({
    id: `worker-control-rejection:${evidence.rejectionId}`,
    kind: 'blocked_turn',
    workspaceId: evidence.workspaceId,
    threadId: evidence.threadId,
    turnId: evidence.turnId,
    agentSessionId: evidence.agentSessionId,
    title: 'Worker control evidence was rejected',
    summary: evidence.message,
    severity: 'risk',
    createdAt: evidence.rejectedAt,
    recommendedAction: 'Open the thread and inspect the rejected worker-control request.',
    source: {
      type: 'worker_control_rejection',
      rejectionId: evidence.rejectionId,
      workspaceId: evidence.workspaceId,
      threadId: evidence.threadId,
      turnId: evidence.turnId,
      agentSessionId: evidence.agentSessionId,
      packageSnapshotId: evidence.packageSnapshotId,
      route: evidence.route,
      operation: evidence.operation,
      errorCode: evidence.errorCode,
      httpStatus: evidence.httpStatus,
    },
    actions: [openThreadAction(evidence.threadId)],
  }));
}

/**
 * Projects scheduler orphan-worker evidence into product-visible attention rows.
 *
 * @param coreDb Open server-scope Core database handle.
 * @param workspaceId Workspace id to project.
 * @returns Scheduler orphan-worker rows.
 */
function schedulerOrphanWorkerRows(coreDb: CoreDb, workspaceId: string): HumanAttentionRow[] {
  return listSchedulerOrphanWorkerEvidenceForWorkspace(coreDb, workspaceId).map((evidence) => ({
    id: `scheduler-orphan-worker:${evidence.evidenceId}`,
    kind: 'blocked_turn',
    workspaceId: evidence.workspaceId,
    threadId: evidence.threadId,
    turnId: evidence.turnId,
    agentSessionId: evidence.agentSessionId,
    title: 'Worker session needs recovery review',
    summary: schedulerOrphanWorkerSummary(evidence),
    severity: 'risk',
    createdAt: evidence.recordedAt,
    recommendedAction: 'Open the thread and decide whether to recover, retry, or abandon the work.',
    source: {
      type: 'scheduler_orphan_worker',
      evidenceId: evidence.evidenceId,
      leaseId: evidence.leaseId,
      workspaceId: evidence.workspaceId,
      threadId: evidence.threadId,
      turnId: evidence.turnId,
      agentSessionId: evidence.agentSessionId,
      packageSnapshotId: evidence.packageSnapshotId,
      reason: evidence.reason,
      schedulerEpoch: evidence.schedulerEpoch,
    },
    actions: [openThreadAction(evidence.threadId)],
  }));
}

/**
 * Builds a product-safe summary for one scheduler orphan-worker evidence row.
 *
 * @param evidence Scheduler orphan-worker evidence.
 * @returns Human-readable summary.
 */
function schedulerOrphanWorkerSummary(evidence: SchedulerOrphanWorkerEvidenceRecord): string {
  return `Scheduler restart found an orphaned worker session after ${evidence.heartbeatDeadline}.`;
}

/**
 * Returns a product title for one scheduler admission entry.
 *
 * @param entry Scheduler admission entry.
 * @returns Human-readable row title.
 */
function schedulerAdmissionTitle(entry: SchedulerAdmissionEntryRecord): string {
  if (entry.status === 'denied') {
    return 'Worker scheduling is blocked';
  }

  return 'Worker turn is queued';
}

/**
 * Returns a product summary for one scheduler admission entry.
 *
 * @param entry Scheduler admission entry.
 * @returns Human-readable row summary.
 */
function schedulerAdmissionSummary(entry: SchedulerAdmissionEntryRecord): string {
  if (entry.denialReason === 'no-healthy-target') {
    return 'No healthy worker target is available for this turn.';
  }

  if (entry.denialReason === 'queue-full') {
    return 'The scheduler queue is full for the required worker pool.';
  }

  if (entry.denialReason === 'policy-cap') {
    return 'A policy cap blocked scheduler admission for this turn.';
  }

  if (entry.status === 'denied') {
    return 'The scheduler denied this worker turn.';
  }

  return 'The worker turn is waiting for scheduler capacity.';
}

/**
 * Returns executable actions for one scheduler admission row.
 *
 * @param workspaceId Workspace id for route construction.
 * @param entry Scheduler admission entry.
 * @returns Actions backed by public App API routes.
 */
function schedulerAdmissionActions(
  workspaceId: string,
  entry: SchedulerAdmissionEntryRecord
): HumanAttentionAction[] {
  const href = `/api/app/workspaces/${workspaceId}/scheduler/admissions/${entry.queueEntryId}`;
  const actions: HumanAttentionAction[] = [openThreadAction(entry.threadId)];

  if (entry.status === 'denied') {
    actions.push({ kind: 'retry_work', label: 'Retry', method: 'POST', href: `${href}/retry` });
  }

  actions.push({ kind: 'abort', label: 'Cancel', method: 'POST', href: `${href}/cancel` });

  return actions;
}

/**
 * Projects pending user turns into pending-input rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to inspect.
 * @returns Pending-input rows.
 */
function pendingInputRows(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  workspaceId: string
): HumanAttentionRow[] {
  return store.listThreads(workspaceId).flatMap((thread) =>
    listPendingUserTurns(workspaceDb, { workspaceId, threadId: thread.id }).map((pendingTurn) => ({
      id: `pending-input:${pendingTurn.pendingTurnId}`,
      kind: 'pending_input',
      workspaceId,
      threadId: thread.id,
      itemId: pendingTurn.contentItemId ?? undefined,
      title: pendingInputTitle(pendingTurn.queueMode),
      summary: pendingInputSummary(pendingTurn.queueMode),
      severity: pendingTurn.queueMode === 'blocked_gate' ? 'needs_input' : 'info',
      createdAt: pendingTurn.createdAt,
      recommendedAction: 'Open the thread to review the queued input.',
      source: {
        type: 'pending_user_turn',
        pendingTurnId: pendingTurn.pendingTurnId,
        requestId: pendingTurn.requestId,
        queueMode: pendingTurn.queueMode,
        workspaceId,
        threadId: thread.id,
      },
      actions: pendingInputActions(workspaceId, thread.id, pendingTurn.requestId),
    }))
  );
}

/**
 * Projects non-terminal worker checkpoints into checkpoint recovery rows.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to inspect.
 * @returns Checkpoint recovery rows.
 */
function checkpointRows(workspaceDb: WorkspaceDb, workspaceId: string): HumanAttentionRow[] {
  return materializeInterruptedWorkerStates(workspaceDb)
    .filter((checkpoint) => checkpoint.workspaceId === workspaceId)
    .map((checkpoint) => ({
      id: `checkpoint:${checkpoint.checkpointId}`,
      kind: 'checkpoint_recovery',
      workspaceId,
      threadId: checkpoint.threadId,
      turnId: checkpoint.turnId,
      agentSessionId: checkpoint.workerSessionId ?? undefined,
      goalId: checkpoint.goalId ?? undefined,
      taskId: checkpoint.taskId ?? undefined,
      title: 'Worker checkpoint needs review',
      summary: checkpoint.diagnosticsSummary ?? `Interrupted during ${checkpoint.stage}.`,
      severity: 'blocked',
      createdAt: checkpoint.sourceUpdatedAt,
      recommendedAction: 'Review the interrupted worker checkpoint before continuing.',
      source: {
        type: 'worker_checkpoint',
        checkpointId: checkpoint.checkpointId,
        workspaceId,
        threadId: checkpoint.threadId,
        turnId: checkpoint.turnId,
        stage: checkpoint.stage,
        stopReason: checkpoint.stopReason,
      },
      actions: [
        openThreadAction(checkpoint.threadId),
        {
          kind: 'retry_from_checkpoint',
          label: 'Retry',
          method: 'POST',
          href: `/api/app/workspaces/${workspaceId}/threads/${checkpoint.threadId}/recovery/interrupted-worker/${checkpoint.turnId}/retry`,
        },
        {
          kind: 'clear_checkpoint',
          label: 'Record terminal',
          method: 'POST',
          href: `/api/app/workspaces/${workspaceId}/threads/${checkpoint.threadId}/recovery/interrupted-worker/${checkpoint.turnId}/terminal`,
        },
      ],
    }));
}

/**
 * Projects workspace synchronization reconciliation records that require human recovery.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to inspect.
 * @returns Workspace recovery rows for non-terminal human recovery decisions.
 */
function workspaceRecoveryRows(workspaceDb: WorkspaceDb, workspaceId: string): HumanAttentionRow[] {
  return listWorkspaceReconciliationRecords(workspaceDb, workspaceId)
    .filter((record) => record.stateAfter === 'requires-human')
    .map(
      (record): HumanAttentionRow => ({
        id: `workspace-recovery:${record.id}`,
        kind: 'blocked_turn',
        workspaceId,
        title: 'Workspace recovery needs review',
        summary: record.requiredHumanDecision
          ? `Recovery requires a human decision: ${record.requiredHumanDecision}.`
          : 'Recovery requires a human decision before NanoCore can continue.',
        severity: 'blocked',
        createdAt: record.startedAt,
        recommendedAction: 'Review the recovery evidence and choose how NanoCore should proceed.',
        source: {
          type: 'workspace_recovery',
          reconciliationRecordId: record.id,
          workspaceId,
          triggerReason: record.triggerReason,
          stateAfter: 'requires-human',
          affectedRecordIds: record.affectedRecordIds,
          evidenceBundleIds: record.evidenceBundleIds,
          requiredHumanDecision: record.requiredHumanDecision,
        },
        actions: workspaceRecoveryActions(workspaceId, record.id),
      })
    );
}

/**
 * Projects goal, goal task, and goal review attention rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to inspect.
 * @returns Goal-backed rows.
 */
function goalRows(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  workspaceId: string
): HumanAttentionRow[] {
  return store
    .listThreads(workspaceId)
    .flatMap((thread) =>
      listGoalRecordsForThread(workspaceDb, { workspaceId, threadId: thread.id }).flatMap(
        (goal) => [...goalStatusRows(goal), ...goalReviewRows(workspaceDb, goal)]
      )
    );
}

/**
 * Projects goal lifecycle states into rows.
 *
 * @param goal Goal record to inspect.
 * @returns Goal state rows.
 */
function goalStatusRows(goal: GoalRecord): HumanAttentionRow[] {
  if (goal.status === 'awaiting_plan_approval') {
    return [
      goalRow(
        goal,
        'artifact_review',
        'Goal plan needs review',
        'Review and approve the goal plan.',
        'needs_input',
        'review_goal_plan'
      ),
    ];
  }

  if (goal.status === 'awaiting_user') {
    return [
      goalRow(
        goal,
        'blocked_turn',
        'Goal is waiting for input',
        'The goal cannot continue until the user responds.',
        'blocked',
        'open_thread'
      ),
    ];
  }

  if (goal.status === 'blocked' || goal.status === 'failed' || goal.status === 'aborted') {
    return [
      goalRow(
        goal,
        goalKindForStopReason(goal.terminalStopReason),
        goalTitleForStopReason(goal.terminalStopReason, goal.status),
        goalSummaryForStopReason(goal.terminalStopReason, goal.status),
        goalSeverityForStopReason(goal.terminalStopReason),
        'open_thread'
      ),
    ];
  }

  return [];
}

/**
 * Builds one goal lifecycle row.
 *
 * @param goal Goal record to project.
 * @param kind Human attention kind.
 * @param title Row title.
 * @param summary Row summary.
 * @param severity Row severity.
 * @param primaryAction Primary action kind.
 * @returns Human Attention row.
 */
function goalRow(
  goal: GoalRecord,
  kind: HumanAttentionRow['kind'],
  title: string,
  summary: string,
  severity: HumanAttentionRow['severity'],
  primaryAction: HumanAttentionAction['kind']
): HumanAttentionRow {
  return {
    id: `goal:${goal.workspaceId}:${goal.threadId}:${goal.goalId}`,
    kind,
    workspaceId: goal.workspaceId,
    threadId: goal.threadId,
    goalId: goal.goalId,
    title,
    summary,
    severity,
    createdAt: goal.updatedAt,
    source: {
      type: 'goal',
      goalId: goal.goalId,
      workspaceId: goal.workspaceId,
      threadId: goal.threadId,
      status: goal.status,
    },
    actions: [
      primaryAction === 'open_thread'
        ? openThreadAction(goal.threadId)
        : {
            kind: primaryAction,
            label: 'Review plan',
            method: 'GET',
            href: `/threads/${goal.threadId}`,
          },
    ],
  };
}

/**
 * Projects non-accept goal review records into rows.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param goal Goal whose tasks should be inspected.
 * @returns Goal review rows.
 */
function goalReviewRows(workspaceDb: WorkspaceDb, goal: GoalRecord): HumanAttentionRow[] {
  return listGoalTasks(workspaceDb, goal).flatMap((task) =>
    listGoalReviewRecordsForTask(workspaceDb, { ...goal, taskId: task.taskId })
      .filter((review) => review.taskId === task.taskId)
      .filter((review) => review.verdict !== 'accept')
      .filter((review) => review.resolvedAt === null)
      .map((review) => ({
        id: `goal-review:${review.workspaceId}:${review.threadId}:${review.goalId}:${review.reviewId}`,
        kind: review.verdict === 'decompose' ? 'review_cap' : 'artifact_review',
        workspaceId: review.workspaceId,
        threadId: review.threadId,
        turnId: review.turnId ?? undefined,
        artifactId: review.artifactIds[0] ?? undefined,
        goalId: review.goalId,
        taskId: review.taskId,
        title: review.verdict === 'ask_user' ? 'Goal review needs input' : 'Review worker output',
        summary: review.reason,
        severity:
          review.verdict === 'block' || review.verdict === 'abort' ? 'blocked' : 'needs_input',
        createdAt: review.updatedAt,
        source: {
          type: 'goal_review',
          reviewId: review.reviewId,
          goalId: review.goalId,
          taskId: review.taskId,
          workspaceId: review.workspaceId,
          threadId: review.threadId,
          verdict: review.verdict,
        },
        actions: goalReviewActions(review, review.artifactIds[0]),
      }))
  );
}

/**
 * Projects blocked or degraded agent readiness records into rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to inspect.
 * @returns Agent readiness rows.
 */
function agentReadinessRows(store: FsStore, workspaceId: string): HumanAttentionRow[] {
  return store
    .getWorkspaceResources(workspaceId)
    .agents.filter((agent) => ['failed', 'offline'].includes(agent.health.status))
    .map((agent) => ({
      id: `agent-readiness:${agent.id}`,
      kind: 'agent_readiness',
      workspaceId,
      agentSessionId: agent.id,
      title: `${agent.name} is ${agent.health.status}`,
      summary: agent.health.message ?? 'Agent readiness needs review.',
      severity:
        agent.health.status === 'failed' || agent.health.status === 'offline' ? 'blocked' : 'risk',
      createdAt: agent.health.checkedAt ?? new Date(0).toISOString(),
      recommendedAction: 'Refresh agent readiness or switch to another configured agent.',
      source: {
        type: 'agent_readiness',
        agentId: agent.id,
        workspaceId,
        status: agent.health.status,
      },
      actions: [
        {
          kind: 'refresh_agent_readiness',
          label: 'Refresh',
          method: 'POST',
          href: `/api/app/workspaces/${workspaceId}/agents/health/refresh`,
        },
        {
          kind: 'switch_agent',
          label: 'Switch agent',
          disabled: true,
          reason: 'Agent switching is managed from workspace settings in this build.',
        },
      ],
    }));
}

/**
 * Projects pending artifact review records into rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to inspect.
 * @returns Artifact review rows.
 */
function artifactReviewRows(store: FsStore, workspaceId: string): HumanAttentionRow[] {
  const decided = new Set(
    store.listArtifactReviewDecisions(workspaceId).map((review) => review.artifactId)
  );

  return store
    .listArtifacts(workspaceId)
    .filter((artifact) => artifact.status === 'ready')
    .filter((artifact) => !decided.has(artifact.id))
    .map((artifact) => {
      const isWorkspaceReview = artifact.id.startsWith('ar_workspace_changes_');

      return {
        id: `artifact:${artifact.id}`,
        kind: isWorkspaceReview ? 'workspace_review' : 'artifact_review',
        workspaceId,
        threadId: artifact.threadId ?? undefined,
        turnId: artifact.turnId ?? undefined,
        artifactId: artifact.id,
        title: isWorkspaceReview ? 'Review workspace changes' : `Review ${artifact.title}`,
        summary: artifact.summary ?? 'The artifact is ready for review.',
        severity: 'needs_input',
        createdAt: artifact.updatedAt,
        recommendedAction: isWorkspaceReview
          ? 'Accept, refine, redo, reject, or defer these workspace changes.'
          : 'Accept, refine, redo, reject, or defer this artifact.',
        source: {
          type: 'artifact',
          artifactId: artifact.id,
          workspaceId,
          threadId: artifact.threadId ?? undefined,
          turnId: artifact.turnId ?? undefined,
          reviewStatus: 'pending',
        },
        actions: artifactReviewActions(workspaceId, artifact.id, artifact.threadId ?? undefined),
      };
    });
}

/**
 * Projects pending knowledge proposals into rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to inspect.
 * @returns Knowledge review rows.
 */
function knowledgeReviewRows(store: FsStore, workspaceId: string): HumanAttentionRow[] {
  return store
    .listKnowledgeProposals(workspaceId)
    .filter((proposal) => proposal.status === 'pending')
    .map((proposal) => ({
      id: `knowledge:${proposal.id}`,
      kind: 'knowledge_review',
      workspaceId,
      title: proposal.title,
      summary: proposal.summary,
      severity: 'needs_input',
      createdAt: proposal.createdAt,
      recommendedAction: 'Accept, edit, reject, or defer the knowledge proposal.',
      source: {
        type: 'knowledge',
        knowledgeProposalId: proposal.id,
        workspaceId,
        status: proposal.status,
      },
      actions: [
        {
          kind: 'accept_knowledge',
          label: 'Accept',
          href: `/api/app/workspaces/${workspaceId}/knowledge/proposals/${proposal.id}/decision`,
          method: 'POST',
        },
        {
          kind: 'edit_knowledge',
          label: 'Edit',
          href: `/api/app/workspaces/${workspaceId}/knowledge/proposals/${proposal.id}/decision`,
          method: 'POST',
        },
        {
          kind: 'reject_knowledge',
          label: 'Reject',
          href: `/api/app/workspaces/${workspaceId}/knowledge/proposals/${proposal.id}/decision`,
          method: 'POST',
        },
        {
          kind: 'defer',
          label: 'Defer',
          href: `/api/app/workspaces/${workspaceId}/knowledge/proposals/${proposal.id}/decision`,
          method: 'POST',
        },
      ],
    }));
}

/**
 * Builds an open-thread action.
 *
 * @param threadId Thread to open.
 * @returns Human Attention action.
 */
function openThreadAction(threadId: string): HumanAttentionAction {
  return {
    kind: 'open_thread',
    label: 'Open thread',
    method: 'GET',
    href: `/threads/${threadId}`,
  };
}

/**
 * Builds artifact review decision actions for an artifact row.
 *
 * @param workspaceId Workspace id.
 * @param artifactId Artifact id.
 * @param threadId Optional thread id.
 * @returns Artifact review actions.
 */
function artifactReviewActions(
  workspaceId: string,
  artifactId: string,
  threadId?: string
): HumanAttentionAction[] {
  const href = `/api/app/workspaces/${workspaceId}/artifacts/${artifactId}/review`;

  return [
    { kind: 'accept_review', label: 'Accept', method: 'POST', href },
    { kind: 'request_refinement', label: 'Refine', method: 'POST', href },
    { kind: 'retry_work', label: 'Redo', method: 'POST', href },
    { kind: 'mark_blocked', label: 'Reject', method: 'POST', href },
    { kind: 'defer', label: 'Defer', method: 'POST', href },
    ...(threadId ? [openThreadAction(threadId)] : []),
  ];
}

/**
 * Builds recovery-safe actions for a durable workspace review fallback row.
 *
 * @param workspaceId Workspace id.
 * @param reviewId Durable staged review id.
 * @param artifactId Backing artifact id, when recorded.
 * @returns Workspace review actions.
 */
function durableWorkspaceReviewActions(
  workspaceId: string,
  reviewId: string,
  artifactId?: string
): HumanAttentionAction[] {
  const reviewHref = `/api/app/workspaces/${workspaceId}/workspace-sync/reviews/${reviewId}`;
  const decisionHref = `${reviewHref}/decision`;

  return [
    {
      kind: 'open_artifact',
      label: 'Open review',
      method: 'GET',
      href: reviewHref,
      disabled: !artifactId,
      reason: artifactId
        ? 'Open the durable workspace review record.'
        : 'The backing artifact is not available; inspect the durable workspace review record.',
    },
    {
      kind: 'accept_review',
      label: 'Accept',
      method: 'POST',
      href: decisionHref,
    },
    {
      kind: 'request_refinement',
      label: 'Refine',
      method: 'POST',
      href: decisionHref,
    },
    {
      kind: 'mark_blocked',
      label: 'Reject',
      method: 'POST',
      href: decisionHref,
    },
    {
      kind: 'defer',
      label: 'Block',
      method: 'POST',
      href: decisionHref,
    },
  ];
}

/**
 * Builds visible recovery choices for a workspace synchronization recovery row.
 *
 * @param workspaceId Workspace id.
 * @param reconciliationRecordId Reconciliation record id.
 * @returns Recovery actions exposed by the Action Center read model.
 */
function workspaceRecoveryActions(
  workspaceId: string,
  reconciliationRecordId: string
): HumanAttentionAction[] {
  const href = `/api/app/workspaces/${workspaceId}/workspace-sync/reconciliation-records/${reconciliationRecordId}/decision`;

  return [
    {
      kind: 'open_artifact',
      label: 'Open evidence',
      method: 'GET',
      href: `/api/app/workspaces/${workspaceId}/workspace-sync/reconciliation-records`,
    },
    { kind: 'retry_work', label: 'Resume collection', method: 'POST', href },
    { kind: 'accept_review', label: 'Stage verified', method: 'POST', href },
    { kind: 'mark_blocked', label: 'Quarantine', method: 'POST', href },
    { kind: 'abort', label: 'Abandon', method: 'POST', href },
  ];
}

/**
 * Builds review actions for one goal review row.
 *
 * @param review Goal Review record to resolve.
 * @param artifactId Optional artifact id to open.
 * @returns Human Attention actions.
 */
function goalReviewActions(
  review: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly goalId: string;
    readonly reviewId: string;
    readonly verdict: string;
  },
  artifactId?: string
): HumanAttentionAction[] {
  const href = `/api/app/workspaces/${review.workspaceId}/threads/${review.threadId}/goals/${review.goalId}/reviews/${review.reviewId}/decision`;
  const verdictAction = goalReviewVerdictAction(review.verdict, href);

  return [
    ...(verdictAction ? [verdictAction] : []),
    openThreadAction(review.threadId),
    ...(artifactId
      ? [
          {
            kind: 'open_artifact' as const,
            label: 'Open artifact',
            method: 'GET' as const,
            href: `/artifacts/${artifactId}`,
          },
        ]
      : []),
  ];
}

/**
 * Builds the executable action that corresponds to one stored review verdict.
 *
 * @param verdict Stored Goal Review verdict.
 * @param href Decision route for resolving the review.
 * @returns Matching executable action, or null when opening context is the action.
 */
function goalReviewVerdictAction(verdict: string, href: string): HumanAttentionAction | null {
  switch (verdict) {
    case 'refine':
    case 'decompose':
      return { kind: 'request_refinement', label: 'Request refinement', method: 'POST', href };
    case 'retry':
      return { kind: 'retry_work', label: 'Retry work', method: 'POST', href };
    case 'block':
      return { kind: 'mark_blocked', label: 'Mark blocked', method: 'POST', href };
    case 'abort':
      return { kind: 'abort', label: 'Abort goal', method: 'POST', href };
    default:
      return null;
  }
}

/**
 * Returns a pending-input title for one queue mode.
 *
 * @param queueMode Queue mode to describe.
 * @returns Human-readable title.
 */
function pendingInputTitle(queueMode: string): string {
  if (queueMode === 'safe_point_steering') {
    return 'Input queued for a safe point';
  }

  if (queueMode === 'blocked_gate') {
    return 'Input blocked behind a human gate';
  }

  return 'Follow-up input is queued';
}

/**
 * Returns a pending-input summary for one queue mode.
 *
 * @param queueMode Queue mode to describe.
 * @returns Human-readable summary.
 */
function pendingInputSummary(queueMode: string): string {
  if (queueMode === 'safe_point_steering') {
    return 'The user message is queued until the worker reaches a safe point.';
  }

  if (queueMode === 'blocked_gate') {
    return 'The user message is waiting behind a blocking human gate.';
  }

  return 'The user message is queued as a follow-up turn.';
}

/**
 * Builds actions for one pending-input Action Center row.
 *
 * @param workspaceId Workspace that owns the pending input.
 * @param threadId Thread that owns the pending input.
 * @param requestId Pending user turn request id.
 * @returns Product actions for reviewing, editing, or cancelling pending input.
 */
function pendingInputActions(
  workspaceId: string,
  threadId: string,
  requestId: string
): HumanAttentionAction[] {
  const base = `/api/app/workspaces/${workspaceId}/threads/${threadId}/recovery/pending-user-turns/${requestId}`;

  return [
    openThreadAction(threadId),
    {
      kind: 'edit_pending_input',
      label: 'Edit pending input',
      method: 'POST',
      href: `${base}/edit`,
    },
    {
      kind: 'convert_pending_input_to_follow_up',
      label: 'Convert to follow-up',
      method: 'POST',
      href: `${base}/follow-up`,
    },
    {
      kind: 'promote_pending_input_to_interrupt',
      label: 'Promote to interrupt',
      method: 'POST',
      href: `${base}/interrupt`,
    },
    {
      kind: 'cancel_pending_input',
      label: 'Cancel pending input',
      method: 'POST',
      href: `${base}/cancel`,
    },
  ];
}

/**
 * Maps a terminal stop reason to a Human Attention kind.
 *
 * @param stopReason Optional terminal stop reason.
 * @returns Human Attention kind.
 */
function goalKindForStopReason(stopReason: StopReason | null): HumanAttentionRow['kind'] {
  if (stopReason === 'budget_exhausted') {
    return 'budget';
  }

  if (stopReason === 'length') {
    return 'review_cap';
  }

  if (stopReason === 'ask_user') {
    return 'question';
  }

  return 'blocked_turn';
}

/**
 * Maps a terminal stop reason to a row title.
 *
 * @param stopReason Optional terminal stop reason.
 * @param status Goal lifecycle status.
 * @returns Human-readable title.
 */
function goalTitleForStopReason(stopReason: StopReason | null, status: string): string {
  if (stopReason === 'budget_exhausted') {
    return 'Budget exhausted';
  }

  if (stopReason === 'length') {
    return 'Review cap reached';
  }

  if (stopReason === 'ask_user') {
    return 'Goal needs input';
  }

  return `Goal is ${status}`;
}

/**
 * Maps a terminal stop reason to a row summary.
 *
 * @param stopReason Optional terminal stop reason.
 * @param status Goal lifecycle status.
 * @returns Human-readable summary.
 */
function goalSummaryForStopReason(stopReason: StopReason | null, status: string): string {
  if (stopReason === 'budget_exhausted') {
    return 'The worker stopped after exhausting its budget.';
  }

  if (stopReason === 'length') {
    return 'The worker reached the review cap or maximum iteration limit.';
  }

  if (stopReason === 'ask_user') {
    return 'The worker needs human input before continuing.';
  }

  return `The goal entered ${status} state and needs review.`;
}

/**
 * Maps a terminal stop reason to a row severity.
 *
 * @param stopReason Optional terminal stop reason.
 * @returns Human Attention severity.
 */
function goalSeverityForStopReason(stopReason: StopReason | null): HumanAttentionRow['severity'] {
  if (stopReason === 'budget_exhausted' || stopReason === 'length') {
    return 'risk';
  }

  return 'blocked';
}
