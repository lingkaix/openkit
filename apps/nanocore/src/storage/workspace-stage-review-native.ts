import { recordFilesystemWorkspaceStagingRoot } from '../runtime/workspace-filesystem-staging.js';
import type { WorkspaceDb } from './db.js';
import {
  type ControlWorkspaceStageReview,
  stageReviewRefusal,
} from './workspace-stage-review-codecs.js';
import { recordWorkspaceSyncReview } from './workspace-stage-review-records.js';

/** Applies the exact original whole stage in the physical owner's existing savepoint. */
export function applyWorkspaceStageReviewInDb(
  db: WorkspaceDb,
  input: ControlWorkspaceStageReview
): void {
  try {
    if (input.staging) recordFilesystemWorkspaceStagingRoot(db, input.staging);
    if (input.review)
      recordWorkspaceSyncReview(db, {
        item: input.review.item,
        ...(input.review.producer ? { producer: input.review.producer } : {}),
      });
  } catch (error) {
    throw stageReviewRefusal(input, error) ?? error;
  }
}
