import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { evaluateGitPushLinkage } from './git-push-linkage.js';
import { recordWorkspaceApplyResult } from './workspace-apply-results.js';
import { recordWorkspaceSyncReview } from './workspace-sync-records.js';

/**
 * Opens a migrated workspace database for Git push linkage tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-push-linkage-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('Git push linkage', () => {
  it('allows commits linked to workspace apply results and returns review ids', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      recordWorkspaceApplyResult(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000031',
        result: {
          appliedAt: '2026-07-05T00:00:00.000Z',
          appliedPaths: ['README.md'],
          changeSetId: 'wcs_1',
          commitIds: ['commit_a', 'commit_b'],
          conflictRecords: [],
          id: 'war_1',
          reviewId: 'swr_1',
          skippedPaths: [],
          status: 'applied',
          verification: [],
          workspaceId: 'ws_demo',
        },
      });

      expect(
        evaluateGitPushLinkage(workspaceDb, {
          commitIds: ['commit_b'],
          requireReviewLinkage: true,
          workspaceId: 'ws_demo',
        })
      ).toEqual({
        allowed: true,
        reviewIds: ['swr_1'],
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('refuses unlinked commits when review linkage is required', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      expect(
        evaluateGitPushLinkage(workspaceDb, {
          commitIds: ['commit_missing'],
          requireReviewLinkage: true,
          workspaceId: 'ws_demo',
        })
      ).toEqual({
        allowed: false,
        missingCommitIds: ['commit_missing'],
        outcome: 'refused-linkage',
        reason: 'unlinked_commits',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('allows commits linked to staged review branches', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      recordWorkspaceSyncReview(workspaceDb, {
        item: {
          artifactId: 'ar_swr_branch',
          changeSet: {
            artifactIds: ['ar_swr_branch'],
            base: { commit: 'base_commit', contentDigest: null },
            bundle: null,
            changedPaths: [{ binary: false, path: 'README.md', status: 'modified' }],
            createdAt: '2026-07-05T00:00:00.000Z',
            evidenceRefs: [{ kind: 'worker', ref: 'turn_1' }],
            head: { commit: 'staged_branch_commit', contentDigest: null },
            id: 'wcs_branch',
            inputSnapshotId: 'wis_branch',
            materializationRecordId: 'wmr_branch',
            patch: { bytes: 42, digest: 'sha256:patch', ref: 'artifact://patch' },
            redaction: { notes: [], status: 'redacted' },
            resourceId: 'repo_default',
            strategy: 'git',
            workspaceId: 'ws_demo',
          },
          patchPayload: {
            bytes: 42,
            digest: 'sha256:patch',
            mediaType: 'text/x-diff',
            text: 'diff --git a/README.md b/README.md\n',
          },
          review: {
            actionCenterRowId: 'workspace-review:swr_branch',
            changeSetId: 'wcs_branch',
            createdAt: '2026-07-05T00:00:00.000Z',
            diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
            id: 'swr_branch',
            riskSummary: '1 changed path staged for human review.',
            staging: {
              branch: 'openkit/review/swr_branch',
              ref: 'staging://workspace/wcs_branch',
              strategy: 'git_worktree',
            },
            status: 'pending',
            updatedAt: '2026-07-05T00:00:00.000Z',
            validation: [],
            workspaceId: 'ws_demo',
          },
        },
      });

      expect(
        evaluateGitPushLinkage(workspaceDb, {
          commitIds: ['staged_branch_commit'],
          requireReviewLinkage: true,
          workspaceId: 'ws_demo',
        })
      ).toEqual({
        allowed: true,
        reviewIds: ['swr_branch'],
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('allows unlinked commits when review linkage is disabled', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      expect(
        evaluateGitPushLinkage(workspaceDb, {
          commitIds: ['manual_commit'],
          requireReviewLinkage: false,
          workspaceId: 'ws_demo',
        })
      ).toEqual({
        allowed: true,
        reviewIds: [],
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
