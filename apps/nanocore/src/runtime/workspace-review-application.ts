import {
  type ArtifactReviewDecision,
  GetWorkspaceSyncReviewResponseSchema,
  type SubmitWorkspaceSyncReviewDecisionResponse,
  WorkspaceApplyPlanSchema,
  type WorkspaceApplyResult,
  type WorkspaceSyncReviewDecision,
  type WorkspaceSyncReviewItem,
} from '@openkit/app-api-schemas';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { getWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import {
  applyStagedFilesystemChanges,
  cleanupCommittedFilesystemRollback,
} from './filesystem-workspace-sync.js';
import { recordWorkspaceApplyPlan } from './workspace-apply-plans.js';
import {
  recordWorkspaceApplyResult,
  requireWorkspaceApplyResult,
} from './workspace-apply-results.js';
import { getFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  applyGitWorkspaceReview,
  discardGitWorkspaceReview,
  stageGitWorkspaceReview,
} from './workspace-review-git.js';
import {
  getWorkspaceSyncReview,
  listWorkspaceSyncReviews,
  parseWorkspaceSyncReviewItem,
  recordWorkspaceSyncReview,
  updateWorkspaceSyncReviewDecision,
} from './workspace-sync-records.js';

/** Process-local command tails keyed by workspace and review id. */
const workspaceReviewDecisionTails = new Map<string, Promise<void>>();

/** Parsed artifact read model used by workspace-review projections. */
type ArtifactReadModel = ReturnType<FsStore['listArtifacts']>[number];

/**
 * Parses one workspace synchronization review artifact into a public App API item.
 *
 * @param artifact Artifact candidate from the workspace store.
 * @returns Parsed workspace sync review item, or null when the artifact is not one.
 */
export function parseWorkspaceSyncReviewArtifact(
  artifact: ArtifactReadModel
): WorkspaceSyncReviewItem | null {
  if (artifact.content.format !== 'json') {
    return null;
  }

  try {
    const parsed = JSON.parse(artifact.content.body) as unknown;

    return GetWorkspaceSyncReviewResponseSchema.parse({
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      artifactId: artifact.id,
    });
  } catch {
    return null;
  }
}

/**
 * Lists parsed workspace synchronization review artifacts in stable newest-first order.
 *
 * @param artifacts Workspace artifact candidates.
 * @returns Parsed workspace sync review items.
 */
export function listWorkspaceSyncReviewArtifacts(
  artifacts: readonly ArtifactReadModel[]
): WorkspaceSyncReviewItem[] {
  return artifacts
    .map(parseWorkspaceSyncReviewArtifact)
    .filter((item): item is WorkspaceSyncReviewItem => item !== null)
    .sort((left, right) => right.review.updatedAt.localeCompare(left.review.updatedAt));
}

/**
 * Lists workspace reviews without mutating artifact or durable state.
 *
 * Durable review lifecycle state takes precedence over immutable artifact snapshots.
 *
 * @param artifacts Workspace artifact candidates.
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace whose reviews should be listed.
 * @returns Durable and artifact-only reviews in stable newest-first order.
 */
export function listWorkspaceSyncReviewsForRead(
  artifacts: readonly ArtifactReadModel[],
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceSyncReviewItem[] {
  const durableReviews = listWorkspaceSyncReviews(workspaceDb, workspaceId);
  const durableReviewIds = new Set(durableReviews.map((item) => item.review.id));

  return [
    ...durableReviews,
    ...listWorkspaceSyncReviewArtifacts(artifacts).filter(
      (item) => !durableReviewIds.has(item.review.id)
    ),
  ].sort((left, right) => right.review.updatedAt.localeCompare(left.review.updatedAt));
}

/**
 * Maps the generic artifact decision vocabulary to the durable workspace-review vocabulary.
 *
 * @param decision Artifact review decision selected by the user.
 * @returns Equivalent durable workspace review decision.
 */
export function workspaceSyncDecisionFromArtifact(
  decision: ArtifactReviewDecision
): WorkspaceSyncReviewDecision {
  if (decision === 'redo') {
    return 'needs_refinement';
  }
  if (decision === 'deferred') {
    return 'blocked';
  }

  return decision;
}

/**
 * Resolves one durable workspace review decision and its optional apply result.
 *
 * The command owns review lifecycle transitions while strategy-specific modules own external
 * effects and compensation. Replaying an already-recorded matching terminal decision is read-only.
 *
 * @param input Workspace database, review identity, decision, and optional artifact fallback.
 * @returns Durable review response shared by both App API decision routes.
 * @throws Error when the review is missing, already resolved differently, or application fails.
 */
export async function decideWorkspaceSyncReview(input: {
  readonly decidedAt: string;
  readonly decision: WorkspaceSyncReviewDecision;
  readonly fallbackReview: WorkspaceSyncReviewItem | null;
  readonly requestId: string;
  readonly reviewId: string;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): Promise<SubmitWorkspaceSyncReviewDecisionResponse> {
  const key = `${input.workspaceId}\0${input.reviewId}`;
  const previous = workspaceReviewDecisionTails.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  workspaceReviewDecisionTails.set(key, tail);
  await previous.catch(() => {});

  try {
    return await executeWorkspaceSyncReviewDecision(input);
  } finally {
    release();
    if (workspaceReviewDecisionTails.get(key) === tail) {
      workspaceReviewDecisionTails.delete(key);
    }
  }
}

/**
 * Executes one serialized workspace-review decision.
 *
 * @param input Canonical workspace-review command input.
 * @returns Durable review response.
 */
async function executeWorkspaceSyncReviewDecision(
  input: Parameters<typeof decideWorkspaceSyncReview>[0]
): Promise<SubmitWorkspaceSyncReviewDecisionResponse> {
  const { workspaceDb, workspaceId, reviewId } = input;
  let review = getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId);

  if (!review) {
    if (!input.fallbackReview) {
      throw new Error(`Workspace synchronization review not found: ${reviewId}`);
    }

    const fallbackReview = parseWorkspaceSyncReviewItem(input.fallbackReview, true);
    if (
      fallbackReview.review.id !== reviewId ||
      fallbackReview.review.workspaceId !== workspaceId
    ) {
      throw new Error(`Workspace synchronization review not found: ${reviewId}`);
    }
    const repository =
      fallbackReview.changeSet.strategy === 'git'
        ? getWorkspaceRepositoryResource(
            workspaceDb,
            workspaceId,
            fallbackReview.changeSet.resourceId
          )
        : null;
    if (
      input.decision === 'accepted' &&
      fallbackReview.changeSet.strategy === 'git' &&
      !repository
    ) {
      throw new Error('Workspace repository is not configured.');
    }
    if (
      input.decision === 'accepted' &&
      fallbackReview.changeSet.strategy === 'git' &&
      !fallbackReview.review.staging.branch &&
      repository?.git.stagingStrategy === 'review-branch'
    ) {
      throw new Error(`Workspace review branch is required: ${fallbackReview.review.id}`);
    }

    if (fallbackReview.changeSet.strategy === 'git' && fallbackReview.review.staging.branch) {
      if (!repository) {
        throw new Error('Workspace repository is not configured.');
      }
      await stageGitWorkspaceReview({
        persistHead: (commitId) => {
          workspaceDb.sqlite.transaction(() => {
            recordWorkspaceSyncReview(workspaceDb, {
              item: {
                ...fallbackReview,
                changeSet: {
                  ...fallbackReview.changeSet,
                  head: { ...fallbackReview.changeSet.head, commit: commitId },
                },
              },
            });
          })();
        },
        repository,
        review: fallbackReview,
        store: input.store,
      });
    } else {
      workspaceDb.sqlite.transaction(() => {
        recordWorkspaceSyncReview(workspaceDb, { item: fallbackReview });
      })();
    }
    review = getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId);
  }

  if (!review) {
    throw new Error(`Workspace synchronization review not found: ${reviewId}`);
  }

  if (review.review.status !== 'pending') {
    if (review.review.status !== input.decision) {
      throw new Error(`Workspace synchronization review is already resolved: ${reviewId}`);
    }

    const workspaceApplyResult =
      input.decision === 'accepted'
        ? requireWorkspaceApplyResult(workspaceDb, workspaceId, `war_${reviewId}`)
        : null;
    if (
      workspaceApplyResult &&
      (workspaceApplyResult.reviewId !== reviewId ||
        workspaceApplyResult.changeSetId !== review.changeSet.id ||
        workspaceApplyResult.workspaceId !== workspaceId)
    ) {
      throw new Error(`Workspace apply result lineage mismatch: ${reviewId}`);
    }
    if (workspaceApplyResult && review.changeSet.strategy === 'filesystem') {
      const staging = getFilesystemWorkspaceStagingRoot(workspaceDb, workspaceId, reviewId);
      if (staging) {
        await cleanupCommittedFilesystemRollback({
          changeSetId: review.changeSet.id,
          reviewId,
          stagingRoot: staging.stagingRootPath,
          stagingRootIdentity: staging.stagingRootIdentity,
          targetRoot: staging.targetRootPath,
          targetRootIdentity: staging.targetRootIdentity,
          workspaceId,
        });
      }
    }

    return {
      review: review.review,
      workspaceApplyResult,
    };
  }

  if (input.decision !== 'accepted') {
    const persistDecision = (): void => {
      workspaceDb.sqlite.transaction(() => {
        updateWorkspaceSyncReviewDecision(workspaceDb, {
          requestId: input.requestId,
          reviewId,
          status: input.decision,
          updatedAt: input.decidedAt,
          workspaceId,
        });
      })();
    };
    const repository =
      review.changeSet.strategy === 'git'
        ? getWorkspaceRepositoryResource(workspaceDb, workspaceId, review.changeSet.resourceId)
        : null;

    if (review.changeSet.strategy === 'git' && review.review.staging.branch && !repository) {
      throw new Error('Workspace repository is not configured.');
    }
    if (review.review.staging.branch && repository) {
      await discardGitWorkspaceReview({ persistDecision, repository, review });
    } else {
      persistDecision();
    }

    return {
      review: requireWorkspaceReview(workspaceDb, workspaceId, reviewId).review,
      workspaceApplyResult: null,
    };
  }

  recordWorkspaceApplyPlanForReview(workspaceDb, review, input.decidedAt);

  if (review.changeSet.strategy === 'filesystem') {
    await applyWorkspaceSyncReviewFilesystem({
      appliedAt: input.decidedAt,
      persistResult: (appliedResult) => {
        workspaceDb.sqlite.transaction(() => {
          recordAcceptedWorkspaceReview(workspaceDb, input, appliedResult);
        })();
      },
      review,
      workspaceDb,
    });

    return {
      review: requireWorkspaceReview(workspaceDb, workspaceId, reviewId).review,
      workspaceApplyResult: requireWorkspaceApplyResult(
        workspaceDb,
        workspaceId,
        `war_${reviewId}`
      ),
    };
  }

  const repository = getWorkspaceRepositoryResource(
    workspaceDb,
    workspaceId,
    review.changeSet.resourceId
  );

  if (!repository) {
    throw new Error('Workspace repository is not configured.');
  }

  const result = await applyGitWorkspaceReview({
    appliedAt: input.decidedAt,
    persistResult: (appliedResult) => {
      workspaceDb.sqlite.transaction(() => {
        recordAcceptedWorkspaceReview(workspaceDb, input, appliedResult);
      })();
    },
    repository,
    review,
    store: input.store,
  });

  return {
    review: requireWorkspaceReview(workspaceDb, workspaceId, reviewId).review,
    workspaceApplyResult: result,
  };
}

/**
 * Persists one accepted review result and terminal decision in the same SQLite transaction.
 *
 * @param workspaceDb Open workspace database already inside the final transaction.
 * @param input Application command input carrying request lineage.
 * @param result Strategy-specific apply result.
 */
function recordAcceptedWorkspaceReview(
  workspaceDb: WorkspaceDb,
  input: {
    readonly decidedAt: string;
    readonly requestId: string;
    readonly reviewId: string;
    readonly workspaceId: string;
  },
  result: WorkspaceApplyResult
): void {
  recordWorkspaceApplyResult(workspaceDb, { requestId: input.requestId, result });
  updateWorkspaceSyncReviewDecision(workspaceDb, {
    requestId: input.requestId,
    reviewId: input.reviewId,
    status: 'accepted',
    updatedAt: input.decidedAt,
    workspaceId: input.workspaceId,
  });
}

/**
 * Applies one accepted filesystem review through its internal staging root.
 *
 * @param input Filesystem review, database, and application timestamp.
 * @returns Product-safe filesystem apply result.
 */
async function applyWorkspaceSyncReviewFilesystem(input: {
  readonly appliedAt: string;
  readonly persistResult: (result: WorkspaceApplyResult) => void;
  readonly review: WorkspaceSyncReviewItem;
  readonly workspaceDb: WorkspaceDb;
}): Promise<WorkspaceApplyResult> {
  const { workspaceDb, review, appliedAt } = input;

  if (review.changeSet.strategy !== 'filesystem') {
    throw new Error(`Workspace review is not filesystem-backed: ${review.review.id}`);
  }

  const staging = getFilesystemWorkspaceStagingRoot(
    workspaceDb,
    review.review.workspaceId,
    review.review.id
  );

  if (!staging) {
    throw new Error(`Filesystem workspace staging root is not available: ${review.review.id}`);
  }
  if (staging.changeSetId !== review.changeSet.id) {
    throw new Error(`Filesystem workspace staging change set mismatch: ${review.review.id}`);
  }
  if (
    staging.before.workspaceId !== review.review.workspaceId ||
    staging.before.resourceId !== review.changeSet.resourceId ||
    staging.before.contentDigest !== review.changeSet.base.contentDigest
  ) {
    throw new Error(`Filesystem workspace staging lineage mismatch: ${review.review.id}`);
  }

  return applyStagedFilesystemChanges({
    appliedAt,
    before: staging.before,
    changeSet: review.changeSet,
    reviewId: review.review.id,
    persistResult: input.persistResult,
    stagingRoot: staging.stagingRootPath,
    stagingRootIdentity: staging.stagingRootIdentity,
    targetRoot: staging.targetRootPath,
    targetRootIdentity: staging.targetRootIdentity,
    workspaceId: review.review.workspaceId,
  });
}

/**
 * Records the existing durable apply plan for one accepted review.
 *
 * @param workspaceDb Open workspace database.
 * @param review Accepted workspace review.
 * @param createdAt Plan timestamp.
 * @returns Stored apply plan.
 */
function recordWorkspaceApplyPlanForReview(
  workspaceDb: WorkspaceDb,
  review: WorkspaceSyncReviewItem,
  createdAt: string
): void {
  recordWorkspaceApplyPlan(
    workspaceDb,
    WorkspaceApplyPlanSchema.parse({
      approvalState: 'approved',
      baselineChecks: review.review.validation,
      binaryRisks: review.changeSet.changedPaths
        .filter((path) => path.binary)
        .map((path) => path.path),
      changeSetId: review.changeSet.id,
      createdAt,
      id: `wap_${review.review.id}`,
      pathConflicts: [],
      permissionChanges: review.changeSet.changedPaths
        .filter(
          (path) =>
            path.oldPermissions &&
            path.newPermissions &&
            path.newPermissions !== path.oldPermissions
        )
        .map((path) => path.path),
      plannedWrites: review.changeSet.changedPaths.flatMap((path) =>
        path.oldPath ? [path.oldPath, path.path] : [path.path]
      ),
      policyChecks: [],
      reviewId: review.review.id,
      strategy: review.changeSet.strategy,
      workspaceId: review.review.workspaceId,
    })
  );
}

/**
 * Requires one durable workspace review after a command transition.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @param reviewId Review id.
 * @returns Stored review item.
 */
function requireWorkspaceReview(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  reviewId: string
): WorkspaceSyncReviewItem {
  const review = getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId);

  if (!review) {
    throw new Error(`Workspace synchronization review not found: ${reviewId}`);
  }

  return review;
}
