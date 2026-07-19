import {
  GetWorkspaceSyncReviewResponseSchema,
  type SubmitWorkspaceSyncReviewDecisionResponse,
  type WorkspaceApplyPlan,
  WorkspaceApplyPlanSchema,
  type WorkspaceApplyResult,
  type WorkspaceSyncReviewDecision,
  type WorkspaceSyncReviewItem,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { listArtifactReviews } from '../artifact-reviews.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  getWorkspaceRepositoryResource,
  type WorkspaceRepositoryResourceRecord,
} from '../workspace/repository-store.js';
import {
  applyStagedFilesystemChanges,
  cleanupCommittedFilesystemRollback,
} from './filesystem-workspace-sync.js';
import { TurnStartValidationError } from './orchestrator.js';
import { recordWorkspaceApplyPlan } from './workspace-apply-plans.js';
import {
  recordWorkspaceApplyResult,
  requireWorkspaceApplyResult,
} from './workspace-apply-results.js';
import {
  type FilesystemWorkspaceStagingRootRecord,
  getFilesystemWorkspaceStagingRoot,
} from './workspace-filesystem-staging.js';
import { applyGitWorkspaceReview, discardGitWorkspaceReview } from './workspace-review-git.js';
import {
  getWorkspaceSyncReview,
  listWorkspaceSyncReviews,
  parseWorkspaceSyncReviewItem,
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
 * Resolves one durable workspace review decision and its optional apply result.
 *
 * The command owns review lifecycle transitions while strategy-specific modules own external
 * effects and compensation. Replaying an already-recorded matching terminal decision is read-only.
 *
 * @param input Current actor authority, Workspace database, review identity, and decision.
 * @returns Durable review response shared by both App API decision routes.
 * @throws Error when the review is missing, already resolved differently, or application fails.
 */
export async function decideWorkspaceSyncReview(input: {
  readonly authorityActor: ActorRef;
  readonly coreDb: CoreDb;
  readonly decidedAt: string;
  readonly decision: WorkspaceSyncReviewDecision;
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
  const storedReview = getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId);

  if (!storedReview) {
    throw new Error(`Workspace synchronization review not found: ${reviewId}`);
  }
  const review = parseWorkspaceSyncReviewItem(storedReview, false);
  if (
    listArtifactReviews(workspaceDb).some(
      (artifactReview) => artifactReview.artifactId === review.artifactId
    )
  ) {
    throw new TurnStartValidationError(
      'recovery_required',
      'The Artifact has conflicting Review authorities and requires recovery.',
      409
    );
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

  const target =
    review.changeSet.strategy === 'filesystem'
      ? {
          kind: 'filesystem' as const,
          staging: requireFilesystemWorkspaceStaging(workspaceDb, review),
        }
      : {
          kind: 'git' as const,
          repository: requireWorkspaceRepository(workspaceDb, review),
        };
  if (
    !currentWorkspaceAuthority(
      input.coreDb,
      workspaceId,
      input.authorityActor,
      'review.apply',
      true
    )
  ) {
    throw new TurnStartValidationError('workspace_access_denied', 'Workspace access denied.', 403);
  }
  const plan = recordWorkspaceApplyPlanForReview(workspaceDb, review, input.decidedAt);

  if (target.kind === 'filesystem') {
    await applyWorkspaceSyncReviewFilesystem({
      appliedAt: plan.createdAt,
      persistResult: (appliedResult) => {
        workspaceDb.sqlite.transaction(() => {
          recordAcceptedWorkspaceReview(workspaceDb, input, appliedResult);
        })();
      },
      review,
      staging: target.staging,
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

  const result = await applyGitWorkspaceReview({
    appliedAt: plan.createdAt,
    persistResult: (appliedResult) => {
      workspaceDb.sqlite.transaction(() => {
        recordAcceptedWorkspaceReview(workspaceDb, input, appliedResult);
      })();
    },
    repository: target.repository,
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
 * @param input Filesystem review, validated staging target, and application timestamp.
 * @returns Product-safe filesystem apply result.
 */
async function applyWorkspaceSyncReviewFilesystem(input: {
  readonly appliedAt: string;
  readonly persistResult: (result: WorkspaceApplyResult) => void;
  readonly review: WorkspaceSyncReviewItem;
  readonly staging: FilesystemWorkspaceStagingRootRecord;
}): Promise<WorkspaceApplyResult> {
  const { review, appliedAt, staging } = input;

  if (review.changeSet.strategy !== 'filesystem') {
    throw new Error(`Workspace review is not filesystem-backed: ${review.review.id}`);
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
 * Requires the exact filesystem target tuple for one pending review.
 *
 * @param workspaceDb Workspace database owning the review target.
 * @param review Pending filesystem review.
 * @returns Matching staging and target-root record.
 * @throws Error when the target tuple is missing or contradictory.
 */
function requireFilesystemWorkspaceStaging(
  workspaceDb: WorkspaceDb,
  review: WorkspaceSyncReviewItem
): FilesystemWorkspaceStagingRootRecord {
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
    staging.workspaceId !== review.review.workspaceId ||
    staging.reviewId !== review.review.id ||
    staging.before.workspaceId !== review.review.workspaceId ||
    staging.before.resourceId !== review.changeSet.resourceId ||
    staging.before.contentDigest !== review.changeSet.base.contentDigest
  ) {
    throw new Error(`Filesystem workspace staging lineage mismatch: ${review.review.id}`);
  }
  return staging;
}

/**
 * Requires the exact configured Git repository target for one pending review.
 *
 * @param workspaceDb Workspace database owning the repository target.
 * @param review Pending Git review.
 * @returns Matching repository resource.
 * @throws Error when the repository target is unavailable or contradictory.
 */
function requireWorkspaceRepository(
  workspaceDb: WorkspaceDb,
  review: WorkspaceSyncReviewItem
): WorkspaceRepositoryResourceRecord {
  const repository = getWorkspaceRepositoryResource(
    workspaceDb,
    review.review.workspaceId,
    review.changeSet.resourceId
  );
  if (
    !repository ||
    repository.workspaceId !== review.review.workspaceId ||
    repository.resourceId !== review.changeSet.resourceId
  ) {
    throw new Error('Workspace repository is not configured.');
  }
  return repository;
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
): WorkspaceApplyPlan {
  return recordWorkspaceApplyPlan(
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
