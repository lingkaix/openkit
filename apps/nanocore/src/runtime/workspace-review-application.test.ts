// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from './filesystem-workspace-sync.js';
import { listWorkspaceApplyPlans } from './workspace-apply-plans.js';
import {
  listWorkspaceApplyResults,
  recordWorkspaceApplyResult,
} from './workspace-apply-results.js';
import { recordFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import { decideWorkspaceSyncReview } from './workspace-review-application.js';
import {
  getWorkspaceSyncReview,
  recordWorkspaceSyncReview,
  updateWorkspaceSyncReviewDecision,
} from './workspace-sync-records.js';

const temporaryRoots: string[] = [];
const LOCAL_AUTHORITY_ACTOR = { kind: 'user', id: LOCAL_USER_ID } as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * Opens current Core authority for the implicit local user and one Workspace.
 *
 * @param dataRoot Test data root shared with the Workspace database.
 * @param workspaceId Workspace owned by the implicit local user.
 * @returns Open migrated Core database with active owner authority.
 */
function openAuthorizedCoreDb(dataRoot: string, workspaceId: string) {
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId });
  return coreDb;
}

describe('workspace review application', () => {
  it('denies a fresh accepted decision after its authenticated user is disabled', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-review-disabled-user-data-'));
    const targetRoot = mkdtempSync(
      join(tmpdir(), 'openkit-workspace-review-disabled-user-target-')
    );
    const workerRoot = mkdtempSync(
      join(tmpdir(), 'openkit-workspace-review-disabled-user-worker-')
    );
    const stagingRoot = mkdtempSync(
      join(tmpdir(), 'openkit-workspace-review-disabled-user-staging-')
    );
    temporaryRoots.push(dataRoot, targetRoot, workerRoot, stagingRoot);
    const workspaceId = 'ws_workspace_review_disabled_user';
    const reviewId = 'swr_workspace_review_disabled_user';
    const timestamp = '2026-07-19T00:00:00.000Z';
    writeFileSync(join(targetRoot, 'review.txt'), 'before\n', 'utf8');
    writeFileSync(join(workerRoot, 'review.txt'), 'after\n', 'utf8');

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId,
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId,
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_workspace_review_disabled_user',
      createdAt: timestamp,
      inputSnapshotId: 'wis_workspace_review_disabled_user',
      materializationRecordId: 'wmr_workspace_review_disabled_user',
    });
    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });

    const coreDb = openAuthorizedCoreDb(dataRoot, workspaceId);
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb);
    try {
      const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
        artifactId: 'ar_workspace_review_disabled_user',
        changeSet,
        patchPayload: null,
        review: {
          actionCenterRowId: `workspace-review:${reviewId}`,
          changeSetId: changeSet.id,
          createdAt: timestamp,
          diffSummary: { additions: 0, deletions: 0, filesChanged: 1 },
          id: reviewId,
          riskSummary: '1 changed path staged for human review.',
          staging: {
            branch: null,
            ref: `filesystem-staging://${reviewId}`,
            strategy: 'filesystem_staging',
          },
          status: 'pending',
          updatedAt: timestamp,
          validation: [],
          workspaceId,
        },
      };
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
      recordFilesystemWorkspaceStagingRoot(workspaceDb, {
        before,
        changeSetId: changeSet.id,
        createdAt: timestamp,
        reviewId,
        stagingRootPath: stagingRoot,
        targetRootPath: targetRoot,
        workspaceId,
      });
      coreDb.sqlite.transaction(() => {
        disableCanonicalUser(coreDb, LOCAL_USER_ID, new Date(timestamp));
      })();

      await expect(
        decideWorkspaceSyncReview({
          authorityActor: LOCAL_AUTHORITY_ACTOR,
          coreDb,
          decidedAt: timestamp,
          decision: 'accepted',
          requestId: 'request-workspace-review-disabled-user',
          reviewId,
          store: new FsStore(),
          workspaceDb,
          workspaceId,
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });
      expect(readFileSync(join(targetRoot, 'review.txt'), 'utf8')).toBe('before\n');
      expect(listWorkspaceApplyPlans(workspaceDb, workspaceId)).toEqual([]);
      expect(listWorkspaceApplyResults(workspaceDb, workspaceId)).toEqual([]);
      expect(getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId)?.review.status).toBe(
        'pending'
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'workspaceId',
    'resourceId',
    'contentDigest',
    'changeSetId',
    'targetRootIdentity',
  ] as const)('rejects filesystem staging with mismatched %s before mutating the target', async (lineageField) => {
    const suffix = lineageField.toLowerCase();
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-filesystem-lineage-${suffix}-data-`));
    const targetRoot = mkdtempSync(join(tmpdir(), `openkit-filesystem-lineage-${suffix}-target-`));
    const workerRoot = mkdtempSync(join(tmpdir(), `openkit-filesystem-lineage-${suffix}-worker-`));
    const stagingRoot = mkdtempSync(
      join(tmpdir(), `openkit-filesystem-lineage-${suffix}-staging-`)
    );
    temporaryRoots.push(dataRoot, targetRoot, workerRoot, stagingRoot);

    const workspaceId = `ws_filesystem_lineage_${suffix}`;
    const reviewId = `swr_filesystem_lineage_${suffix}`;
    const changeSetId = `wcs_filesystem_lineage_${suffix}`;
    const timestamp = '2026-07-11T00:00:00.000Z';
    writeFileSync(join(targetRoot, 'review.txt'), 'before\n', 'utf8');
    writeFileSync(join(workerRoot, 'review.txt'), 'after\n', 'utf8');

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId,
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId,
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId,
      createdAt: timestamp,
      inputSnapshotId: `wis_filesystem_lineage_${suffix}`,
      materializationRecordId: `wmr_filesystem_lineage_${suffix}`,
    });
    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });

    const coreDb = openAuthorizedCoreDb(dataRoot, workspaceId);
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb);
    try {
      const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
        artifactId: `ar_filesystem_lineage_${suffix}`,
        changeSet,
        patchPayload: null,
        review: {
          actionCenterRowId: `workspace-review:${reviewId}`,
          changeSetId,
          createdAt: timestamp,
          diffSummary: { additions: 0, deletions: 0, filesChanged: 1 },
          id: reviewId,
          riskSummary: '1 changed path staged for human review.',
          staging: {
            branch: null,
            ref: `filesystem-staging://${reviewId}`,
            strategy: 'filesystem_staging',
          },
          status: 'pending',
          updatedAt: timestamp,
          validation: [],
          workspaceId,
        },
      };
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
      recordFilesystemWorkspaceStagingRoot(workspaceDb, {
        before: {
          ...before,
          contentDigest:
            lineageField === 'contentDigest' ? `sha256:${'0'.repeat(64)}` : before.contentDigest,
          resourceId: lineageField === 'resourceId' ? 'fs_other' : before.resourceId,
          workspaceId: lineageField === 'workspaceId' ? 'ws_other' : before.workspaceId,
        },
        changeSetId: lineageField === 'changeSetId' ? 'wcs_other' : changeSetId,
        createdAt: timestamp,
        reviewId,
        stagingRootPath: stagingRoot,
        targetRootPath: targetRoot,
        workspaceId,
      });
      let originalTargetRoot: string | null = null;
      if (lineageField === 'targetRootIdentity') {
        originalTargetRoot = `${targetRoot}-original`;
        temporaryRoots.push(originalTargetRoot);
        renameSync(targetRoot, originalTargetRoot);
        mkdirSync(targetRoot);
        writeFileSync(join(targetRoot, 'review.txt'), 'before\n', 'utf8');
      }

      let decisionError: unknown;
      try {
        await decideWorkspaceSyncReview({
          authorityActor: LOCAL_AUTHORITY_ACTOR,
          coreDb,
          decidedAt: timestamp,
          decision: 'accepted',
          requestId: `request-filesystem-lineage-${suffix}`,
          reviewId,
          store: new FsStore(),
          workspaceDb,
          workspaceId,
        });
      } catch (error) {
        decisionError = error;
      }

      expect(readFileSync(join(targetRoot, 'review.txt'), 'utf8')).toBe('before\n');
      expect(decisionError).toBeInstanceOf(Error);
      expect(getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId)?.review.status).toBe(
        'pending'
      );
      if (originalTargetRoot) {
        rmSync(targetRoot, { force: true, recursive: true });
        renameSync(originalTargetRoot, targetRoot);
        const retried = await decideWorkspaceSyncReview({
          authorityActor: LOCAL_AUTHORITY_ACTOR,
          coreDb,
          decidedAt: '2026-07-11T00:00:01.000Z',
          decision: 'accepted',
          requestId: `request-filesystem-lineage-${suffix}-retry`,
          reviewId,
          store: new FsStore(),
          workspaceDb,
          workspaceId,
        });

        expect(retried.workspaceApplyResult?.appliedAt).toBe(timestamp);
      }
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('removes committed filesystem rollback data when an accepted decision is replayed', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-cleanup-data-'));
    const targetRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-cleanup-target-'));
    const workerRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-cleanup-worker-'));
    const stagingRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-cleanup-staging-'));
    temporaryRoots.push(dataRoot, targetRoot, workerRoot, stagingRoot);
    const workspaceId = 'ws_filesystem_cleanup';
    const reviewId = 'swr_filesystem_cleanup';
    const timestamp = '2026-07-11T00:10:00.000Z';
    writeFileSync(join(workerRoot, 'new.txt'), 'applied\n', 'utf8');
    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId,
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId,
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_filesystem_cleanup',
      createdAt: timestamp,
      inputSnapshotId: 'wis_filesystem_cleanup',
      materializationRecordId: 'wmr_filesystem_cleanup',
    });
    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
    const coreDb = openAuthorizedCoreDb(dataRoot, workspaceId);
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
        artifactId: 'ar_filesystem_cleanup',
        changeSet,
        patchPayload: null,
        review: {
          actionCenterRowId: `workspace-review:${reviewId}`,
          changeSetId: changeSet.id,
          createdAt: timestamp,
          diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
          id: reviewId,
          riskSummary: '1 changed path staged for human review.',
          staging: {
            branch: null,
            ref: `filesystem-staging://${reviewId}`,
            strategy: 'filesystem_staging',
          },
          status: 'pending',
          updatedAt: timestamp,
          validation: [],
          workspaceId,
        },
      };
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
      const staging = recordFilesystemWorkspaceStagingRoot(workspaceDb, {
        before,
        changeSetId: changeSet.id,
        createdAt: timestamp,
        reviewId,
        stagingRootPath: stagingRoot,
        targetRootPath: targetRoot,
        workspaceId,
      });
      const requestId = '00000000-0000-4000-8000-000000000051';
      recordWorkspaceApplyResult(workspaceDb, {
        requestId,
        result: {
          appliedAt: timestamp,
          appliedPaths: ['new.txt'],
          changeSetId: changeSet.id,
          commitIds: [],
          conflictRecords: [],
          id: `war_${reviewId}`,
          reviewId,
          skippedPaths: [],
          status: 'applied',
          verification: [],
          workspaceId,
        },
      });
      updateWorkspaceSyncReviewDecision(workspaceDb, {
        requestId,
        reviewId,
        status: 'accepted',
        updatedAt: timestamp,
        workspaceId,
      });
      const rollbackRoot = join(
        stagingRoot,
        `.openkit-workspace-rollback-${createHash('sha256')
          .update(`${workspaceId}\0${reviewId}`)
          .digest('hex')}`
      );
      mkdirSync(join(rollbackRoot, 'files'), { recursive: true });
      writeFileSync(
        join(rollbackRoot, 'ready.json'),
        JSON.stringify({
          changeSetId: changeSet.id,
          replacementPaths: ['new.txt'],
          reviewId,
          stagingRootIdentity: staging.stagingRootIdentity,
          targetRootDigest: `sha256:${createHash('sha256')
            .update(Buffer.from(realpathSync(targetRoot)))
            .digest('hex')}`,
          targetRootIdentity: staging.targetRootIdentity,
          version: 1,
          workspaceId,
        }),
        'utf8'
      );

      await decideWorkspaceSyncReview({
        authorityActor: LOCAL_AUTHORITY_ACTOR,
        coreDb,
        decidedAt: timestamp,
        decision: 'accepted',
        requestId: '00000000-0000-4000-8000-000000000052',
        reviewId,
        store: new FsStore(),
        workspaceDb,
        workspaceId,
      });

      expect(existsSync(rollbackRoot)).toBe(false);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records a Git review rejection without touching its retired host branch', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-discard-missing-repository-'));
    temporaryRoots.push(dataRoot);
    const item = gitRenameWorkspaceReviewItem();
    const coreDb = openAuthorizedCoreDb(dataRoot, item.review.workspaceId);
    const workspaceDb = openWorkspaceDb(dataRoot, item.review.workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });

      await expect(
        decideWorkspaceSyncReview({
          authorityActor: LOCAL_AUTHORITY_ACTOR,
          coreDb,
          decidedAt: '2026-07-11T00:12:00.000Z',
          decision: 'rejected',
          requestId: 'request-git-discard-missing-repository',
          reviewId: item.review.id,
          store: new FsStore(),
          workspaceDb,
          workspaceId: item.review.workspaceId,
        })
      ).resolves.toMatchObject({ review: { status: 'rejected' }, workspaceApplyResult: null });
      expect(
        getWorkspaceSyncReview(workspaceDb, item.review.workspaceId, item.review.id)?.review.status
      ).toBe('rejected');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('does not create a durable review from an artifact fallback', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-review-fallback-data-'));
    temporaryRoots.push(dataRoot);
    const fallbackReview = gitRenameWorkspaceReviewItem();
    const workspaceId = fallbackReview.review.workspaceId;
    const coreDb = openAuthorizedCoreDb(dataRoot, workspaceId);
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, fallbackReview);
      await expect(
        decideWorkspaceSyncReview({
          authorityActor: LOCAL_AUTHORITY_ACTOR,
          coreDb,
          decidedAt: '2026-07-11T00:13:00.000Z',
          decision: 'rejected',
          requestId: 'request-git-fallback-discard',
          reviewId: fallbackReview.review.id,
          store: createDemoStore(),
          workspaceDb,
          workspaceId,
        })
      ).rejects.toThrow(`Workspace synchronization review not found: ${fallbackReview.review.id}`);
      expect(getWorkspaceSyncReview(workspaceDb, workspaceId, fallbackReview.review.id)).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

/**
 * Builds one schema-valid Git rename review without a configured repository resource.
 *
 * @returns Pending Git review whose patch deletes the source and adds the destination.
 */
function gitRenameWorkspaceReviewItem(): Parameters<typeof recordWorkspaceSyncReview>[1]['item'] {
  const patchText = [
    'diff --git a/old.txt b/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
    '',
  ].join('\n');
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
  const timestamp = '2026-07-11T00:10:00.000Z';

  return {
    artifactId: 'ar_git_rename_review',
    changeSet: {
      artifactIds: ['ar_git_rename_review'],
      base: { commit: 'a'.repeat(40), contentDigest: null },
      bundle: null,
      changedPaths: [
        {
          binary: false,
          oldPath: 'old.txt',
          path: 'new.txt',
          status: 'renamed',
        },
      ],
      createdAt: timestamp,
      evidenceRefs: [{ kind: 'worker', ref: 'turn_git_rename' }],
      head: { commit: 'b'.repeat(40), contentDigest: null },
      id: 'wcs_git_rename',
      inputSnapshotId: 'wis_git_rename',
      materializationRecordId: 'wmr_git_rename',
      patch: {
        bytes: Buffer.byteLength(patchText, 'utf8'),
        digest: patchDigest,
        ref: 'worker-session://workspace.patch',
      },
      redaction: { notes: [], status: 'redacted' },
      resourceId: 'repo_default',
      strategy: 'git',
      workspaceId: 'ws_git_rename',
    },
    patchPayload: {
      bytes: Buffer.byteLength(patchText, 'utf8'),
      digest: patchDigest,
      mediaType: 'text/x-diff',
      text: patchText,
    },
    review: {
      actionCenterRowId: 'workspace-review:swr_git_rename',
      changeSetId: 'wcs_git_rename',
      createdAt: timestamp,
      diffSummary: { additions: 0, deletions: 0, filesChanged: 1 },
      id: 'swr_git_rename',
      riskSummary: 'One renamed path staged for review.',
      staging: {
        branch: 'openkit/review/swr_git_rename',
        ref: 'staging://workspace/wcs_git_rename',
        strategy: 'git_worktree',
      },
      status: 'pending',
      updatedAt: timestamp,
      validation: [],
      workspaceId: 'ws_git_rename',
    },
  };
}
