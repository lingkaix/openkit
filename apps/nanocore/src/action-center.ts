import { createHash } from 'node:crypto';
import {
  type HumanAttentionAction,
  type HumanAttentionRow,
  ListHumanAttentionResponseSchema,
} from '@openkit/app-api-schemas';
import type { StopReason } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { asApiError } from './api-errors.js';
import { listArtifactReviews } from './artifact-reviews.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import { readPendingGoalSteeringProjection } from './context/worker-context-projection.js';
import { GoalSteeringAuthorityError } from './goal-steering-authority.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import { listGoalReviewRecordsForTask } from './runtime/goal-review-records.js';
import { type GoalRecord, listGoalRecordsForThread, listGoalTasks } from './runtime/goal-store.js';
import { listWorkerControlRejectedEvidenceForWorkspace } from './runtime/worker-control-rejected-evidence.js';
import {
  hasExactActiveHumanGate,
  materializeInterruptedWorkerStates,
} from './runtime/worker-recovery.js';
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
type UserInputRequestStoreItem = Extract<StoreItem, { type: 'user-input-request' }>;
type UserInputResponseStoreItem = Extract<StoreItem, { type: 'user-input-response' }>;

/**
 * Input used to build unified Human Attention rows.
 */
interface BuildHumanAttentionRowsInput {
  /** Authenticated actor requesting the projection. */
  actor?: Actor | undefined;
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
 * Registers the workspace Action Center route.
 *
 * @param dependencies Hono app, request-scoped storage, and optional durable databases.
 */
export function registerActionCenterRoutes({
  app,
  coreDb,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'listHumanAttention', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');

      store.getWorkspace(workspaceId);
      const workspaceDb = coreDb ? repositoryWorkspaceDb(workspaceId) : undefined;
      try {
        return c.json(
          ListHumanAttentionResponseSchema.parse({
            items: buildHumanAttentionRows({
              actor: c.get('actor'),
              store,
              coreDb,
              workspaceDb,
              workspaceId,
            }),
          })
        );
      } finally {
        workspaceDb?.sqlite.close();
      }
    } catch (error) {
      if (error instanceof GoalSteeringAuthorityError) {
        return asApiError(error.message, error.code, error.status);
      }
      return asApiError((error as Error).message);
    }
  });
}

/**
 * Builds unified Human Attention rows for every currently backed NanoCore source.
 *
 * @param input Projection dependencies and workspace scope.
 * @returns Human Attention rows in deterministic creation order.
 */
function buildHumanAttentionRows(input: BuildHumanAttentionRowsInput): HumanAttentionRow[] {
  const approvalDecisionAuthorized =
    input.coreDb === undefined ||
    (input.actor !== undefined &&
      isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.workspaceId, {
        mutating: true,
        policyOperation: 'approval.respond',
      }));
  const turnDecisionAuthorized =
    input.coreDb === undefined ||
    (input.actor !== undefined &&
      isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.workspaceId, {
        mutating: true,
        policyOperation: 'turn.run',
      }));
  const reviewDecisionAuthorized =
    input.coreDb === undefined ||
    (input.actor !== undefined &&
      isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.workspaceId, {
        mutating: true,
        policyOperation: 'review.apply',
      }));
  const rows = [
    ...(approvalDecisionAuthorized ? approvalRows(input.store, input.workspaceId) : []),
    ...questionRows(
      input.store,
      input.workspaceId,
      turnDecisionAuthorized ? (input.actor?.userId ?? null) : null
    ),
    ...runtimeRows(input, reviewDecisionAuthorized),
    ...agentReadinessRows(input.store, input.workspaceId),
    ...(reviewDecisionAuthorized ? artifactReviewRows(input) : []),
    ...durableWorkspaceReviewRows(input, reviewDecisionAuthorized),
    ...(reviewDecisionAuthorized ? knowledgeReviewRows(input.store, input.workspaceId) : []),
  ];

  return rows.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

/**
 * Projects exact unresolved version-keyed Artifact Reviews into Action Center rows.
 *
 * @param input Projection dependencies and Workspace scope.
 * @returns Review rows backed by the exact current ready turn-output Artifact.
 */
function artifactReviewRows(input: BuildHumanAttentionRowsInput): HumanAttentionRow[] {
  if (!input.workspaceDb) {
    return [];
  }

  const artifacts = new Map(
    input.store.listArtifacts(input.workspaceId).map((artifact) => [artifact.id, artifact])
  );
  const workspaceReviewArtifactIds = new Set(
    listWorkspaceSyncReviews(input.workspaceDb, input.workspaceId).map((item) => item.artifactId)
  );

  return listArtifactReviews(input.workspaceDb)
    .filter((review) => review.decision === null)
    .filter((review) => !workspaceReviewArtifactIds.has(review.artifactId))
    .flatMap((review) => {
      const artifact = artifacts.get(review.artifactId);
      if (!review.sourceThreadId || !review.sourceTurnId) {
        return [];
      }
      let sourceTurn: ReturnType<FsStore['getTurn']>;
      try {
        sourceTurn = input.store.getTurn(
          review.workspaceId,
          review.sourceThreadId,
          review.sourceTurnId
        );
      } catch {
        return [];
      }
      const canonicalDigest = `sha256:${createHash('sha256')
        .update(artifact?.content.body ?? '', 'utf8')
        .digest('hex')}`;
      if (
        !artifact ||
        artifact.workspaceId !== review.workspaceId ||
        artifact.status !== 'ready' ||
        artifact.version !== review.artifactVersion ||
        artifact.contentDigest !== review.contentDigest ||
        artifact.origin.kind !== 'turn-output' ||
        artifact.threadId !== review.sourceThreadId ||
        artifact.turnId !== review.sourceTurnId ||
        artifact.origin.threadId !== review.sourceThreadId ||
        artifact.origin.turnId !== review.sourceTurnId ||
        artifact.contentDigest !== canonicalDigest ||
        (sourceTurn.agentId ?? null) !== review.sourceAgentId
      ) {
        return [];
      }

      return [
        {
          id: `artifact-review:${review.reviewId}`,
          kind: 'artifact_review',
          workspaceId: review.workspaceId,
          threadId: review.sourceThreadId,
          turnId: review.sourceTurnId,
          reviewId: review.reviewId,
          artifactId: review.artifactId,
          artifactVersion: review.artifactVersion,
          title: `Review ${artifact.title}`,
          summary:
            artifact.summary ?? `Artifact version ${review.artifactVersion} is ready for review.`,
          severity: 'needs_input',
          createdAt: review.createdAt,
          recommendedAction:
            'Inspect this exact Artifact version before taking a decision through its owning API.',
          source: {
            type: 'artifact_review',
            reviewId: review.reviewId,
            artifactId: review.artifactId,
            artifactVersion: review.artifactVersion,
            workspaceId: review.workspaceId,
            threadId: review.sourceThreadId,
            turnId: review.sourceTurnId,
          },
          actions: [
            {
              kind: 'open_artifact',
              label: 'Open artifact',
              method: 'GET',
              href: `/api/workspaces/${review.workspaceId}/artifacts/${review.artifactId}`,
            },
          ],
        },
      ];
    });
}

/**
 * Projects pending durable staged workspace reviews into Action Center rows.
 *
 * @param input Projection dependencies and workspace scope.
 * @param reviewDecisionAuthorized Whether the actor may apply a current review decision.
 * @returns Pending actionable or contradictory-owner inspection Workspace Review rows.
 */
function durableWorkspaceReviewRows(
  input: BuildHumanAttentionRowsInput,
  reviewDecisionAuthorized: boolean
): HumanAttentionRow[] {
  if (!input.workspaceDb) {
    return [];
  }

  const genericReviewArtifactIds = new Set(
    listArtifactReviews(input.workspaceDb).map((review) => review.artifactId)
  );

  return listWorkspaceSyncReviews(input.workspaceDb, input.workspaceId)
    .filter((item) => {
      const inspectOnlyRecovery = genericReviewArtifactIds.has(item.artifactId);
      return inspectOnlyRecovery || (reviewDecisionAuthorized && item.review.status === 'pending');
    })
    .map((item) => {
      const inspectOnlyRecovery = genericReviewArtifactIds.has(item.artifactId);
      return {
        id: item.review.actionCenterRowId,
        kind: 'workspace_review',
        workspaceId: item.review.workspaceId,
        artifactId: item.artifactId,
        title: 'Review workspace changes',
        summary: item.review.riskSummary,
        severity: inspectOnlyRecovery ? 'risk' : 'needs_input',
        createdAt: item.review.updatedAt,
        recommendedAction: inspectOnlyRecovery
          ? 'Inspect the contradictory Review owners before taking action.'
          : 'Inspect, accept, refine, reject, or block these workspace changes.',
        source: {
          type: 'workspace_review',
          reviewId: item.review.id,
          changeSetId: item.review.changeSetId,
          artifactId: item.artifactId,
          workspaceId: item.review.workspaceId,
          status: item.review.status,
        },
        actions: durableWorkspaceReviewActions(
          input.workspaceId,
          item.review.id,
          item.artifactId,
          inspectOnlyRecovery,
          item.review.status === 'pending'
        ),
      } satisfies HumanAttentionRow;
    });
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
 * Checks whether one approval Item has the exact pending Gate owners required for actionability.
 *
 * @param store Product store containing the Turn and Approval owners.
 * @param item Approval request Item to validate.
 * @returns True only for one completed request owned by the active pending Approval Gate.
 */
function isActionableApprovalRequest(store: FsStore, item: ApprovalRequestStoreItem): boolean {
  if (item.status !== 'completed') {
    return false;
  }
  try {
    const turn = store.getTurn(item.workspaceId, item.threadId, item.turnId);
    return (
      hasExactActiveHumanGate(store, turn) &&
      turn.humanGate.kind === 'approval' &&
      turn.humanGate.itemId === item.id &&
      turn.humanGate.approvalRequestId === item.approvalRequestId
    );
  } catch {
    return false;
  }
}

/**
 * Checks whether one question Item has the exact active Gate owners required for visibility.
 *
 * @param store Product store containing the Turn owner.
 * @param item User-input request Item to validate.
 * @returns True only for one completed request with unique questions and an exact active Gate.
 */
function isExactUserInputRequest(store: FsStore, item: UserInputRequestStoreItem): boolean {
  const questionIds = item.questions.map((question) => question.id);
  if (item.status !== 'completed' || new Set(questionIds).size !== questionIds.length) {
    return false;
  }
  try {
    const turn = store.getTurn(item.workspaceId, item.threadId, item.turnId);
    return (
      hasExactActiveHumanGate(store, turn) &&
      turn.humanGate.kind === 'user-input' &&
      turn.humanGate.itemId === item.id &&
      turn.humanGate.userInputRequestId === item.userInputRequestId
    );
  } catch {
    return false;
  }
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
    .filter((item) => isActionableApprovalRequest(store, item))
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
 * @param responsibleUserId Authorized actor id that must own the request.
 * @returns Question rows.
 */
function questionRows(
  store: FsStore,
  workspaceId: string,
  responsibleUserId: string | null
): HumanAttentionRow[] {
  const items = store.listAllItems().filter((item) => item.workspaceId === workspaceId);
  const responses = new Set(
    items.filter(isUserInputResponseItem).map((item) => item.userInputRequestId)
  );

  return items
    .filter(isUserInputRequestItem)
    .filter((item) => item.responsibleUserId === responsibleUserId)
    .filter((item) => !responses.has(item.userInputRequestId))
    .filter((item) => isExactUserInputRequest(store, item))
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
          ...(item.questions.some((question) => question.isSecret)
            ? {
                disabled: true,
                reason: 'Secret answers require a future Vault-backed input contract.',
              }
            : {}),
        },
        openThreadAction(item.threadId),
      ],
    }));
}

/**
 * Projects app-local runtime rows backed by the Core database.
 *
 * @param input Projection dependencies and workspace scope.
 * @param reviewDecisionAuthorized Whether the actor may apply review decisions.
 * @returns Runtime-backed rows with Goal reviews filtered by current authority.
 */
function runtimeRows(
  input: BuildHumanAttentionRowsInput,
  reviewDecisionAuthorized: boolean
): HumanAttentionRow[] {
  if (!input.coreDb) {
    return [];
  }

  return [
    ...schedulerAdmissionRows(input.coreDb, input.workspaceId),
    ...workerControlRejectedEvidenceRows(input.coreDb, input.workspaceId),
    ...schedulerOrphanWorkerRows(input.coreDb, input.workspaceId),
    ...(input.workspaceDb
      ? checkpointRows(input.coreDb, input.store, input.workspaceDb, input.workspaceId)
      : []),
    ...(input.workspaceDb ? workspaceRecoveryRows(input.workspaceDb, input.workspaceId) : []),
    ...(input.workspaceDb
      ? goalRows(input.store, input.workspaceDb, input.workspaceId, reviewDecisionAuthorized)
      : []),
    ...(input.workspaceDb ? pendingGoalSteeringRows(input) : []),
  ];
}

/**
 * Projects the singular verified pending Goal input for each Thread.
 *
 * @param input Existing read-only authority owners and Workspace scope.
 * @returns Product-safe pending input rows without input text or Material tuples.
 */
function pendingGoalSteeringRows(input: BuildHumanAttentionRowsInput): HumanAttentionRow[] {
  const { coreDb, workspaceDb } = input;
  if (!coreDb || !workspaceDb) {
    return [];
  }

  return input.store.listThreads(input.workspaceId).flatMap((thread) => {
    const projection = readPendingGoalSteeringProjection({
      coreDb,
      store: input.store,
      workspaceDb,
      threadId: thread.id,
    });
    if (!projection) {
      return [];
    }

    const { owner, state } = projection;
    const actions: HumanAttentionAction[] = [openThreadAction(owner.threadId)];
    if (state === 'queued' && projection.originalGoalTerminal) {
      const href = `/api/app/workspaces/${owner.workspaceId}/threads/${owner.threadId}/goal/steering/${owner.pendingTurnId}`;
      actions.push(
        {
          kind: 'run_follow_up',
          label: 'Convert to follow-up',
          method: 'POST',
          href: `${href}/follow-up`,
        },
        { kind: 'abort', label: 'Cancel', method: 'POST', href: `${href}/cancel` }
      );
    }

    return [
      {
        id: `pending-input:${owner.pendingTurnId}`,
        kind: 'pending_input',
        workspaceId: owner.workspaceId,
        threadId: owner.threadId,
        turnId: owner.activeTurnId,
        itemId: owner.contentItemId,
        goalId: owner.goalId,
        title: state === 'queued' ? 'Goal input is queued' : 'Goal input was delivered',
        summary:
          state === 'queued'
            ? 'Accepted input is waiting for its owning Goal.'
            : 'Accepted input has exact worker delivery proof and is awaiting cleanup.',
        severity: 'info',
        createdAt: owner.receivedAt,
        recommendedAction:
          state === 'queued' && projection.originalGoalTerminal
            ? 'Convert the input to follow-up history or cancel it.'
            : 'Open the thread to inspect the current Goal.',
        source: {
          type: 'pending_input',
          workspaceId: owner.workspaceId,
          threadId: owner.threadId,
          pendingTurnId: owner.pendingTurnId,
          requestId: owner.requestId,
          contentItemId: owner.contentItemId,
          goalId: owner.goalId,
          activeTurnId: owner.activeTurnId,
          state,
        },
        actions,
      },
    ];
  });
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
    title: 'Worker attempt needs recovery review',
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
  return `Scheduler restart found an orphaned worker attempt after ${evidence.heartbeatDeadline}.`;
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
 * Projects non-terminal worker checkpoints into checkpoint recovery rows.
 *
 * @param coreDb Open Core database handle.
 * @param store Product store that owns the source Turn and AgentSession.
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to inspect.
 * @returns Checkpoint recovery rows.
 */
function checkpointRows(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  workspaceId: string
): HumanAttentionRow[] {
  return materializeInterruptedWorkerStates(coreDb, store, workspaceDb)
    .filter((checkpoint) => checkpoint.workspaceId === workspaceId)
    .map((checkpoint) => ({
      id: `checkpoint:${checkpoint.checkpointId}`,
      kind: 'checkpoint_recovery',
      workspaceId,
      threadId: checkpoint.threadId,
      turnId: checkpoint.turnId,
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
      actions: checkpoint.choices.some((choice) => choice.kind === 'retry')
        ? [
            openThreadAction(checkpoint.threadId),
            {
              kind: 'retry_from_checkpoint',
              label: 'Retry',
              method: 'POST',
              href: `/api/app/workspaces/${workspaceId}/threads/${checkpoint.threadId}/recovery/interrupted-worker/${checkpoint.turnId}/retry`,
            },
          ]
        : [openThreadAction(checkpoint.threadId)],
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
 * @param reviewDecisionAuthorized Whether the actor may apply Goal review decisions.
 * @returns Goal status rows plus currently authorized Goal review rows.
 */
function goalRows(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  reviewDecisionAuthorized: boolean
): HumanAttentionRow[] {
  return store
    .listThreads(workspaceId)
    .flatMap((thread) =>
      listGoalRecordsForThread(workspaceDb, { workspaceId, threadId: thread.id }).flatMap(
        (goal) => [
          ...goalStatusRows(goal, reviewDecisionAuthorized),
          ...(reviewDecisionAuthorized ? goalReviewRows(workspaceDb, goal) : []),
        ]
      )
    );
}

/**
 * Projects goal lifecycle states into rows.
 *
 * @param goal Goal record to inspect.
 * @param reviewDecisionAuthorized Whether the actor may apply Goal review decisions.
 * @returns Goal state rows.
 */
function goalStatusRows(goal: GoalRecord, reviewDecisionAuthorized: boolean): HumanAttentionRow[] {
  if (goal.status === 'awaiting_plan_approval') {
    if (!reviewDecisionAuthorized) {
      return [];
    }
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
 * Projects a unique actionable unresolved Goal Review into a row.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param goal Goal whose tasks should be inspected.
 * @returns The unique actionable row, or none for zero or multiple unresolved Reviews.
 */
function goalReviewRows(workspaceDb: WorkspaceDb, goal: GoalRecord): HumanAttentionRow[] {
  const task = listGoalTasks(workspaceDb, goal).find(
    (candidate) => candidate.taskId === goal.currentTaskId
  );
  if (goal.status !== 'reviewing' || task?.status !== 'reviewing') {
    return [];
  }

  const unresolvedReviews = listGoalReviewRecordsForTask(workspaceDb, {
    ...goal,
    taskId: task.taskId,
  }).filter((review) => review.resolvedAt === null && review.reviewId.length > 0);
  if (unresolvedReviews.length !== 1) {
    return [];
  }

  return unresolvedReviews.map((review) => ({
    id: `goal-review:${review.workspaceId}:${review.threadId}:${review.goalId}:${review.reviewId}`,
    kind: 'artifact_review' as const,
    workspaceId: review.workspaceId,
    threadId: review.threadId,
    turnId: review.turnId,
    artifactId: review.artifactIds[0] ?? undefined,
    goalId: review.goalId,
    taskId: review.taskId,
    title: 'Review worker output',
    summary: review.prompt,
    severity: 'needs_input' as const,
    createdAt: review.updatedAt,
    source: {
      type: 'goal_review',
      reviewId: review.reviewId,
      goalId: review.goalId,
      taskId: review.taskId,
      workspaceId: review.workspaceId,
      threadId: review.threadId,
    },
    actions: goalReviewActions(review),
  }));
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
 * Projects pending Knowledge proposals into rows.
 *
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to inspect.
 * @returns Knowledge review rows.
 */
function knowledgeReviewRows(store: FsStore, workspaceId: string): HumanAttentionRow[] {
  return store.listKnowledgeProposals(workspaceId).flatMap((proposal) => {
    const decision = store.getKnowledgeProposalReviewDecision(proposal.id)?.decision;
    if (decision === 'accepted' || decision === 'rejected') {
      return [];
    }
    const status = decision ?? 'pending';

    return [
      {
        id: `knowledge:${proposal.id}`,
        kind: 'knowledge_review',
        workspaceId,
        title: `Review knowledge proposal for ${proposal.knowledgePageId}`,
        summary: proposal.rationale,
        severity: 'needs_input',
        createdAt: proposal.createdAt,
        recommendedAction: 'Accept, reject, or defer the knowledge proposal.',
        source: {
          type: 'knowledge',
          knowledgeProposalId: proposal.id,
          workspaceId,
          status,
        },
        actions: [
          {
            kind: 'accept_knowledge',
            label: 'Accept',
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
      },
    ];
  });
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
 * Builds actions owned by one durable Workspace Review.
 *
 * @param workspaceId Workspace id.
 * @param reviewId Durable Workspace Review id.
 * @param artifactId Optional presentation Artifact id.
 * @param inspectOnlyRecovery Whether contradictory generic Review authority disables decisions.
 * @param pending Whether the durable Review remains open for a decision.
 * @returns Workspace Review actions.
 */
function durableWorkspaceReviewActions(
  workspaceId: string,
  reviewId: string,
  artifactId?: string,
  inspectOnlyRecovery = false,
  pending = true
): HumanAttentionAction[] {
  const reviewHref = `/api/app/workspaces/${workspaceId}/workspace-sync/reviews/${reviewId}`;
  const decisionHref = `${reviewHref}/decision`;

  const actions: HumanAttentionAction[] = [
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
      kind: 'accepted',
      label: 'Accept',
      method: 'POST',
      href: decisionHref,
    },
    {
      kind: 'needs_refinement',
      label: 'Refine',
      method: 'POST',
      href: decisionHref,
    },
    {
      kind: 'rejected',
      label: 'Reject',
      method: 'POST',
      href: decisionHref,
    },
    {
      kind: 'blocked',
      label: 'Block',
      method: 'POST',
      href: decisionHref,
    },
  ];
  if (inspectOnlyRecovery) {
    for (const action of actions.slice(1)) {
      action.disabled = true;
      action.reason = 'recovery_required: The backing Artifact has contradictory Review authority.';
    }
  }
  return pending ? actions : actions.slice(0, 1);
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
 * @returns Human Attention actions.
 */
function goalReviewActions(review: {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly goalId: string;
  readonly reviewId: string;
}): HumanAttentionAction[] {
  const href = `/api/app/workspaces/${review.workspaceId}/threads/${review.threadId}/goals/${review.goalId}/reviews/${review.reviewId}/decision`;

  return [
    { kind: 'accept_review', label: 'Accept review', method: 'POST', href },
    { kind: 'request_refinement', label: 'Request refinement', method: 'POST', href },
    { kind: 'retry_work', label: 'Retry work', method: 'POST', href },
    { kind: 'abort', label: 'Abort goal', method: 'POST', href },
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
