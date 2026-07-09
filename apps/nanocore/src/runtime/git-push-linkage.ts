import type { GitPushRecord } from '@openkit/app-api-schemas';
import type { WorkspaceDb } from '../storage/db.js';
import { listWorkspaceApplyResults } from './workspace-apply-results.js';
import { listWorkspaceSyncReviews } from './workspace-sync-records.js';

/** Input for evaluating Git push commit lineage. */
export interface EvaluateGitPushLinkageInput {
  /** Workspace that owns the apply results. */
  readonly workspaceId: string;
  /** Commit ids requested for publication. */
  readonly commitIds: readonly string[];
  /** Whether all pushed commits must link back to workspace review applies. */
  readonly requireReviewLinkage: boolean;
}

/** Successful Git push linkage evaluation. */
export interface GitPushLinkageAllowed {
  /** Whether the push commits passed linkage evaluation. */
  readonly allowed: true;
  /** Review ids linked to the requested commits. */
  readonly reviewIds: string[];
}

/** Failed Git push linkage evaluation. */
export interface GitPushLinkageDenied {
  /** Whether the push commits passed linkage evaluation. */
  readonly allowed: false;
  /** Missing commit ids that could not be linked to accepted reviews. */
  readonly missingCommitIds: string[];
  /** Typed Git push outcome to record. */
  readonly outcome: GitPushRecord['outcome'];
  /** Stable denial reason. */
  readonly reason: 'unlinked_commits';
}

/** Git push linkage evaluation result. */
export type GitPushLinkageDecision = GitPushLinkageAllowed | GitPushLinkageDenied;

/**
 * Evaluates whether requested push commits are linked to accepted workspace reviews.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Linkage input.
 * @returns Linkage decision used before any remote mutation is attempted.
 */
export function evaluateGitPushLinkage(
  workspaceDb: WorkspaceDb,
  input: EvaluateGitPushLinkageInput
): GitPushLinkageDecision {
  if (!input.requireReviewLinkage) {
    return { allowed: true, reviewIds: [] };
  }

  const commitToReviewId = new Map<string, string>();
  for (const result of listWorkspaceApplyResults(workspaceDb, input.workspaceId)) {
    for (const commitId of result.commitIds) {
      commitToReviewId.set(commitId, result.reviewId);
    }
  }
  for (const review of listWorkspaceSyncReviews(workspaceDb, input.workspaceId)) {
    if (
      review.changeSet.strategy === 'git' &&
      review.review.staging.branch &&
      review.changeSet.head.commit
    ) {
      commitToReviewId.set(review.changeSet.head.commit, review.review.id);
    }
  }

  const missingCommitIds = input.commitIds.filter((commitId) => !commitToReviewId.has(commitId));

  if (missingCommitIds.length > 0) {
    return {
      allowed: false,
      missingCommitIds,
      outcome: 'refused-linkage',
      reason: 'unlinked_commits',
    };
  }

  return {
    allowed: true,
    reviewIds: unique(input.commitIds.map((commitId) => commitToReviewId.get(commitId) ?? '')),
  };
}

/**
 * Returns unique non-empty values in first-seen order.
 *
 * @param values Candidate string values.
 * @returns Unique non-empty values.
 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
