import { createHash } from 'node:crypto';
import {
  type HumanAttentionAction,
  type HumanAttentionRow,
  ListHumanAttentionResponseSchema,
  operationHttpPath,
} from '@openkit/app-api-schemas';
import { publishedErrorMessage } from './api-errors.js';
import { listArtifactReviews } from './artifact-reviews.js';
import type { Actor } from './auth/identity.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import { isArtifactVisible, isThreadIdVisible, isThreadVisible } from './auth/thread-visibility.js';
import type { FsStore } from './lib/store.js';
import { listOpenSchedulerExecutionAttempts } from './runtime/execution-attempt-records.js';
import { pendingRequestPresentation } from './runtime/pending-request-flow.js';
import { listThreadPendingRequests, validateCanonicalLoad } from './runtime/pending-requests.js';
import { listWorkerControlRejectedEvidenceForWorkspace } from './runtime/worker-control-rejected-evidence.js';
import { materializeInterruptedWorkerStates } from './runtime/worker-recovery.js';
import { listWorkspaceReconciliationRecords } from './runtime/workspace-reconciliation-records.js';
import { listWorkspaceSyncReviews } from './runtime/workspace-sync-records.js';
import {
  listSchedulerAdmissionEntriesForWorkspace,
  type SchedulerAdmissionEntryRecord,
} from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

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
  /** Current administrator eligibility supplied by the existing authorizer. */
  administratorEligible?: boolean;
}

/** Owner-local attention read failure; invocation preserves its published message, code and status. */
export class HumanAttentionReadError extends Error {
  public readonly code = 'not_found';
  public readonly status = 404;

  public constructor(message: string) {
    super(message);
    this.name = 'HumanAttentionReadError';
  }
}

/** Reads unified attention through the existing projection owner after native Workspace admission. */
export function readHumanAttention(
  input: BuildHumanAttentionRowsInput & {
    repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  }
) {
  let workspaceDb: WorkspaceDb | undefined;
  try {
    input.store.getWorkspace(input.workspaceId);
    workspaceDb = input.coreDb ? input.repositoryWorkspaceDb(input.workspaceId) : undefined;
    return ListHumanAttentionResponseSchema.parse({
      items: buildHumanAttentionRows({ ...input, workspaceDb }),
    });
  } catch (error) {
    throw new HumanAttentionReadError(publishedErrorMessage(error));
  } finally {
    workspaceDb?.sqlite.close();
  }
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
  const reviewDecisionAuthorized =
    input.coreDb === undefined ||
    (input.actor !== undefined &&
      isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.workspaceId, {
        mutating: true,
        policyOperation: 'review.apply',
      }));
  const rows = [
    ...(approvalDecisionAuthorized ? pendingRequestRows(input) : []),
    ...runtimeRows(input),
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
 * Returns Threads the current Action Center viewer may use before dependent reads.
 *
 * @param input Projection dependencies and Workspace scope.
 * @returns Threads visible to the authenticated viewer.
 */
function visibleThreadsForActor(input: BuildHumanAttentionRowsInput) {
  return input.store
    .listThreads(input.workspaceId)
    .filter((thread) =>
      isThreadVisible(input.store, thread, input.actor?.userId, input.administratorEligible)
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

  const workspaceReviewArtifactIds = new Set(
    listWorkspaceSyncReviews(input.workspaceDb, input.workspaceId).map((item) => item.artifactId)
  );

  return listArtifactReviews(input.workspaceDb)
    .filter((review) => review.decision === null)
    .filter((review) => !workspaceReviewArtifactIds.has(review.artifactId))
    .filter((review): review is typeof review & { sourceThreadId: string; sourceTurnId: string } =>
      Boolean(review.sourceThreadId && review.sourceTurnId)
    )
    .filter((review) =>
      isThreadIdVisible(
        input.store,
        review.workspaceId,
        review.sourceThreadId,
        input.actor?.userId,
        input.administratorEligible
      )
    )
    .flatMap((review) => {
      let artifact: ReturnType<FsStore['getArtifact']> | undefined;
      try {
        artifact = input.store.getArtifact(review.workspaceId, review.artifactId);
      } catch {
        artifact = undefined;
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
              method: 'POST',
              href: operationHttpPath('artifact.read'),
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
      const origin = visibleWorkspaceReviewOrigin(input, item.artifactId);
      return {
        id: item.review.actionCenterRowId,
        kind: 'workspace_review',
        workspaceId: item.review.workspaceId,
        artifactId: item.artifactId,
        ...(origin ?? {}),
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
          item.artifactId,
          inspectOnlyRecovery,
          item.review.status === 'pending'
        ),
      } satisfies HumanAttentionRow;
    });
}

/**
 * Returns originating Thread and Turn ids from one workspace-review Artifact when the viewer may see that Thread.
 *
 * Missing, workspace-mismatched, or non-turn-output Artifacts omit lineage and leave the workspace-scoped row intact.
 * Exact origin Thread/Turn match and current audience reuse `isArtifactVisible`.
 *
 * @param input Projection dependencies and Workspace scope.
 * @param artifactId Backing Artifact id recorded on the durable review.
 * @returns Visible origin ids, or null when lineage must stay omitted.
 */
function visibleWorkspaceReviewOrigin(
  input: BuildHumanAttentionRowsInput,
  artifactId: string
): { readonly threadId: string; readonly turnId: string } | null {
  let artifact: ReturnType<FsStore['getArtifact']>;
  try {
    artifact = input.store.getArtifact(input.workspaceId, artifactId);
  } catch {
    return null;
  }
  if (artifact.workspaceId !== input.workspaceId || artifact.origin.kind !== 'turn-output') {
    return null;
  }
  if (!isArtifactVisible(input.store, artifact, input.actor?.userId, input.administratorEligible)) {
    return null;
  }
  return { threadId: artifact.origin.threadId, turnId: artifact.origin.turnId };
}

/**
 * Projects every pending request on a visible Thread.
 *
 * @param input Projection dependencies and Workspace scope.
 * @returns Approval and question rows backed by the Workspace pending-request records.
 */
function pendingRequestRows(input: BuildHumanAttentionRowsInput): HumanAttentionRow[] {
  if (!input.workspaceDb) {
    return [];
  }
  const rows: HumanAttentionRow[] = [];
  for (const thread of visibleThreadsForActor(input)) {
    let records: ReturnType<typeof listThreadPendingRequests>;
    try {
      records = listThreadPendingRequests(input.workspaceDb.sqlite, input.workspaceId, thread.id);
    } catch {
      continue;
    }
    const turns = input.store.listThreadTurns(input.workspaceId, thread.id);
    for (const record of records) {
      if (record.state !== 'pending') continue;
      if (
        input.actor &&
        record.responsibleUserId !== input.actor.userId &&
        !input.administratorEligible
      )
        continue;
      const contradiction = validateCanonicalLoad(
        record,
        input.store
          .listThreads(input.workspaceId)
          .flatMap((candidate) => input.store.listThreadTurns(input.workspaceId, candidate.id)),
        input.store.listCommandRequests()
      );
      const presentation = pendingRequestPresentation(record, turns);
      const secret = (record.questions ?? []).some((question) => question.isSecret === true);
      if (record.kind === 'approval') {
        rows.push({
          id: `approval:${record.requestId}`,
          kind: 'approval',
          workspaceId: record.workspaceId,
          threadId: record.threadId,
          turnId: record.raisingTurnId,
          itemId: record.requestItemId,
          title: record.title ?? 'Approval required',
          summary: record.description ?? 'Review and respond to the approval request.',
          severity: 'needs_input',
          createdAt: record.createdAt,
          ageSeconds: presentation.ageSeconds,
          turnsSince: presentation.turnsSince,
          blocking: presentation.blocking,
          recommendedAction: 'Review and respond to the approval request.',
          source: {
            type: 'approval',
            approvalRequestId: record.requestId,
            workspaceId: record.workspaceId,
            threadId: record.threadId,
            turnId: record.raisingTurnId,
            itemId: record.requestItemId,
          },
          actions: contradiction
            ? [openThreadAction(thread.id)]
            : [
                {
                  kind: 'grant_approval',
                  label: 'Approve',
                  method: 'POST',
                  href: operationHttpPath('approval.respond'),
                },
                {
                  kind: 'deny_approval',
                  label: 'Deny',
                  method: 'POST',
                  href: operationHttpPath('approval.respond'),
                },
                {
                  kind: 'withdraw_request',
                  label: 'Withdraw',
                  method: 'POST',
                  href: operationHttpPath('pending-request.withdraw'),
                },
                openThreadAction(thread.id),
              ],
        });
        continue;
      }
      rows.push({
        id: `question:${record.requestId}`,
        kind: 'question',
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        turnId: record.raisingTurnId,
        itemId: record.requestItemId,
        title: 'Answer required',
        summary: 'Answer the question on its pending request.',
        severity: 'needs_input',
        createdAt: record.createdAt,
        ageSeconds: presentation.ageSeconds,
        turnsSince: presentation.turnsSince,
        blocking: presentation.blocking,
        recommendedAction: 'Answer the question before the next Turn can use it.',
        source: {
          type: 'protocol_item',
          itemType: 'user-input-request',
          workspaceId: record.workspaceId,
          threadId: record.threadId,
          turnId: record.raisingTurnId,
          itemId: record.requestItemId,
        },
        actions: contradiction
          ? [openThreadAction(thread.id)]
          : [
              {
                kind: 'answer_question',
                label: 'Answer',
                method: 'POST',
                href: operationHttpPath('question.answer'),
                ...(secret
                  ? {
                      disabled: true,
                      reason: 'Secret answers are not supported.',
                    }
                  : {}),
              },
              {
                kind: 'withdraw_request',
                label: 'Withdraw',
                method: 'POST',
                href: operationHttpPath('pending-request.withdraw'),
              },
              openThreadAction(thread.id),
            ],
      });
    }
  }
  return rows;
}

/**
 * Projects app-local runtime rows backed by the Core database.
 *
 * @param input Projection dependencies and workspace scope.
 * @returns Runtime-backed rows admitted by current Workspace and Thread authority.
 */
function runtimeRows(input: BuildHumanAttentionRowsInput): HumanAttentionRow[] {
  if (!input.coreDb) {
    return [];
  }

  return [
    ...schedulerAdmissionRows(input.coreDb, input.store, input.workspaceId, input.actor?.userId),
    ...workerControlRejectedEvidenceRows(
      input.coreDb,
      input.store,
      input.workspaceId,
      input.actor?.userId
    ),
    ...schedulerOrphanWorkerRows(input.coreDb, input.store, input.workspaceId, input.actor?.userId),
    ...(input.workspaceDb
      ? checkpointRows(
          input.coreDb,
          input.store,
          input.workspaceDb,
          input.workspaceId,
          input.actor?.userId
        )
      : []),
    ...(input.workspaceDb ? workspaceRecoveryRows(input.workspaceDb, input.workspaceId) : []),
  ];
}

/**
 * Projects durable scheduler admissions into product-visible attention rows.
 *
 * @param coreDb Open server-scope Core database handle.
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to project.
 * @param userId Authenticated viewer.
 * @returns Scheduler admission rows for queued or human-actionable denied entries.
 */
function schedulerAdmissionRows(
  coreDb: CoreDb,
  store: FsStore,
  workspaceId: string,
  userId: string | undefined
): HumanAttentionRow[] {
  return listSchedulerAdmissionEntriesForWorkspace(coreDb, {
    workspaceId,
    statuses: ['queued', 'denied'],
  })
    .filter((entry) => isThreadIdVisible(store, entry.workspaceId, entry.threadId, userId))
    .map((entry) => {
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
        },
        actions: schedulerAdmissionActions(entry),
      };
    });
}

/**
 * Projects rejected worker-control evidence into product-visible attention rows.
 *
 * @param coreDb Open server-scope Core database handle.
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace id to project.
 * @param userId Authenticated viewer.
 * @returns Worker-control rejection rows.
 */
function workerControlRejectedEvidenceRows(
  coreDb: CoreDb,
  store: FsStore,
  workspaceId: string,
  userId: string | undefined
): HumanAttentionRow[] {
  return listWorkerControlRejectedEvidenceForWorkspace(coreDb, workspaceId)
    .filter((evidence) => isThreadIdVisible(store, evidence.workspaceId, evidence.threadId, userId))
    .map((evidence) => ({
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

/** Projects held execution uncertainty from the attempt authority itself. */
function schedulerOrphanWorkerRows(
  coreDb: CoreDb,
  store: FsStore,
  workspaceId: string,
  userId: string | undefined
): HumanAttentionRow[] {
  return listOpenSchedulerExecutionAttempts(coreDb)
    .filter(
      (attempt) =>
        attempt.workspaceId === workspaceId &&
        (attempt.phase === 'closing' || attempt.disposition === 'unknown') &&
        isThreadIdVisible(store, workspaceId, attempt.threadId, userId)
    )
    .map((attempt) => ({
      id: `execution-attempt:${attempt.attemptId}`,
      kind: 'blocked_turn',
      workspaceId,
      threadId: attempt.threadId,
      turnId: attempt.turnId,
      title: 'Worker attempt needs recovery review',
      summary: `Execution attempt is ${attempt.phase} with ${attempt.disposition} acceptance.`,
      severity: 'risk',
      createdAt: attempt.updatedAt,
      recommendedAction: 'Open the thread and inspect the original execution attempt.',
      source: {
        type: 'execution_attempt',
        attemptId: attempt.attemptId,
        backendId: attempt.backendId,
        phase: attempt.phase,
        disposition: attempt.disposition,
        workspaceId,
        threadId: attempt.threadId,
        turnId: attempt.turnId,
      },
      actions: [openThreadAction(attempt.threadId)],
    }));
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
  if (entry.denialReason === 'queue-full') {
    return 'The worker admission queue is full.';
  }

  if (entry.denialReason === 'authority-denied') {
    return 'Current launch authority is unavailable for this Turn.';
  }

  if (entry.status === 'denied') {
    return 'The scheduler denied this worker turn.';
  }

  return 'The worker turn is waiting for scheduler capacity.';
}

/**
 * Returns executable actions for one scheduler admission row.
 *
 * @param entry Scheduler admission entry.
 * @returns Actions backed by public App API routes.
 */
function schedulerAdmissionActions(entry: SchedulerAdmissionEntryRecord): HumanAttentionAction[] {
  const actions: HumanAttentionAction[] = [openThreadAction(entry.threadId)];

  if (entry.status === 'denied') {
    actions.push({
      kind: 'retry_work',
      label: 'Retry',
      method: 'POST',
      href: '/api/app/operations/scheduler.retry',
    });
  }

  actions.push({
    kind: 'abort',
    label: 'Cancel',
    method: 'POST',
    href: '/api/app/operations/scheduler.cancel',
  });

  return actions;
}

/**
 * Projects non-terminal worker checkpoints into checkpoint recovery rows.
 *
 * @param coreDb Open Core database handle.
 * @param store Product store that owns the source Turn and AgentSession.
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id to inspect.
 * @param userId Authenticated viewer.
 * @returns Checkpoint recovery rows.
 */
function checkpointRows(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  userId: string | undefined
): HumanAttentionRow[] {
  return materializeInterruptedWorkerStates(
    coreDb,
    store,
    workspaceDb,
    (checkpoint) =>
      checkpoint.workspaceId === workspaceId &&
      isThreadIdVisible(store, checkpoint.workspaceId, checkpoint.threadId, userId)
  ).map((checkpoint) => ({
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
            href: '/api/app/operations/recovery.checkpoint-retry',
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
        actions: workspaceRecoveryActions(),
      })
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
          href: '/api/app/operations/agent.health-refresh',
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
            href: operationHttpPath('knowledge.proposal.decide'),
            method: 'POST',
          },
          {
            kind: 'reject_knowledge',
            label: 'Reject',
            href: operationHttpPath('knowledge.proposal.decide'),
            method: 'POST',
          },
          {
            kind: 'defer',
            label: 'Defer',
            href: operationHttpPath('knowledge.proposal.decide'),
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
 * @param artifactId Optional presentation Artifact id.
 * @param inspectOnlyRecovery Whether contradictory generic Review authority disables decisions.
 * @param pending Whether the durable Review remains open for a decision.
 * @returns Workspace Review actions.
 */
function durableWorkspaceReviewActions(
  artifactId?: string,
  inspectOnlyRecovery = false,
  pending = true
): HumanAttentionAction[] {
  const reviewHref = operationHttpPath('sync.review-read');
  const decisionHref = operationHttpPath('sync.review-decide');

  const actions: HumanAttentionAction[] = [
    {
      kind: 'open_artifact',
      label: 'Open review',
      method: 'POST',
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
 * @returns Recovery actions exposed by the Action Center read model.
 */
function workspaceRecoveryActions(): HumanAttentionAction[] {
  const href = operationHttpPath('sync.recovery-decide');

  return [
    {
      kind: 'open_artifact',
      label: 'Open evidence',
      method: 'POST',
      href: operationHttpPath('sync.reconciliation-list'),
    },
    { kind: 'retry_work', label: 'Resume collection', method: 'POST', href },
    { kind: 'accept_review', label: 'Stage verified', method: 'POST', href },
    { kind: 'mark_blocked', label: 'Quarantine', method: 'POST', href },
    { kind: 'abort', label: 'Abandon', method: 'POST', href },
  ];
}
