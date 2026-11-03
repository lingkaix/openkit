import { OperationError } from '../operation-error-core.js';
import { acceptAppliedWorkspaceSnapshot } from '../runtime/workspace-snapshot-chain.js';
import type { WorkspaceDb } from './db.js';
import { recordWorkspaceApplyResult } from './workspace-apply-result-records.js';
import type { ControlWorkspaceReviewFinish } from './workspace-review-codecs.js';
import { WorkspaceReviewDecisionRefusal } from './workspace-review-codecs.js';
import {
  requireWorkspaceSyncReview,
  throwWorkspaceReviewRefusal,
  updateWorkspaceSyncReviewDecision,
} from './workspace-review-records.js';

/** Publishes the original complete accepted finish inside the physical owner's existing savepoint. */
export function applyWorkspaceReviewFinishInDb(
  workspaceDb: WorkspaceDb,
  input: ControlWorkspaceReviewFinish
): void {
  try {
    const review = requireWorkspaceSyncReview(workspaceDb, input.workspaceId, input.reviewId);
    if (review.review.status !== 'pending') throw new WorkspaceReviewDecisionRefusal('resolved');
    const result = input.result;
    if (
      result.workspaceId !== input.workspaceId ||
      result.reviewId !== input.reviewId ||
      result.changeSetId !== review.changeSet.id ||
      result.id !== `war_${input.reviewId}`
    )
      throw new Error('Workspace apply result lineage mismatch.');
    const attribution = {
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.authentication ? { authentication: input.authentication } : {}),
    };
    recordWorkspaceApplyResult(workspaceDb, { ...attribution, requestId: input.requestId, result });
    if (result.status === 'applied') {
      try {
        acceptAppliedWorkspaceSnapshot(
          workspaceDb,
          input.workspaceId,
          review.changeSet.id,
          result.commitIds.at(-1) ?? review.changeSet.head.commit
        );
      } catch (error) {
        if (
          error instanceof OperationError &&
          error.code === 'workspace_sync_review_failed' &&
          error.message === 'Workspace snapshot accepted base changed during apply.'
        )
          throw new WorkspaceReviewDecisionRefusal('base_changed');
        throw error;
      }
    }
    updateWorkspaceSyncReviewDecision(workspaceDb, {
      ...attribution,
      requestId: input.requestId,
      reviewId: input.reviewId,
      status: 'accepted',
      updatedAt: input.updatedAt,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    throwWorkspaceReviewRefusal(error, input);
  }
}
