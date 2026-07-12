import { execFileSync } from 'node:child_process';
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
import { FsStore } from '../lib/store.js';
import { openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from './filesystem-workspace-sync.js';
import { listWorkspaceApplyPlans } from './workspace-apply-plans.js';
import { recordWorkspaceApplyResult } from './workspace-apply-results.js';
import { recordFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import { decideWorkspaceSyncReview } from './workspace-review-application.js';
import { stageGitWorkspaceReview } from './workspace-review-git.js';
import {
  getWorkspaceSyncReview,
  recordWorkspaceSyncReview,
  updateWorkspaceSyncReviewDecision,
} from './workspace-sync-records.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('workspace review application', () => {
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

    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, workspaceId);
    applyScopedMigrations(workspaceDb);
    try {
      recordWorkspaceSyncReview(workspaceDb, {
        item: {
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
        },
      });
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
      if (lineageField === 'targetRootIdentity') {
        const originalTargetRoot = `${targetRoot}-original`;
        temporaryRoots.push(originalTargetRoot);
        renameSync(targetRoot, originalTargetRoot);
        mkdirSync(targetRoot);
        writeFileSync(join(targetRoot, 'review.txt'), 'before\n', 'utf8');
      }

      let decisionError: unknown;
      try {
        await decideWorkspaceSyncReview({
          decidedAt: timestamp,
          decision: 'accepted',
          fallbackReview: null,
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
    } finally {
      workspaceDb.sqlite.close();
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
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      recordWorkspaceSyncReview(workspaceDb, {
        item: {
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
        },
      });
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
        decidedAt: timestamp,
        decision: 'accepted',
        fallbackReview: null,
        requestId: '00000000-0000-4000-8000-000000000052',
        reviewId,
        store: new FsStore(),
        workspaceDb,
        workspaceId,
      });

      expect(existsSync(rollbackRoot)).toBe(false);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('includes both rename endpoints in the durable apply plan', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-rename-plan-'));
    temporaryRoots.push(dataRoot);
    const item = gitRenameWorkspaceReviewItem();
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, item.review.workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      recordWorkspaceSyncReview(workspaceDb, { item });

      await expect(
        decideWorkspaceSyncReview({
          decidedAt: '2026-07-11T00:11:00.000Z',
          decision: 'accepted',
          fallbackReview: null,
          requestId: 'request-git-rename-plan',
          reviewId: item.review.id,
          store: new FsStore(),
          workspaceDb,
          workspaceId: item.review.workspaceId,
        })
      ).rejects.toThrow(/repository/i);

      const plan = listWorkspaceApplyPlans(workspaceDb, item.review.workspaceId)[0];
      expect(plan?.plannedWrites).toHaveLength(2);
      expect(plan?.plannedWrites).toEqual(expect.arrayContaining(['old.txt', 'new.txt']));
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('keeps a staged Git review pending when its missing repository prevents branch cleanup', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-discard-missing-repository-'));
    temporaryRoots.push(dataRoot);
    const item = gitRenameWorkspaceReviewItem();
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, item.review.workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      recordWorkspaceSyncReview(workspaceDb, { item });

      await expect(
        decideWorkspaceSyncReview({
          decidedAt: '2026-07-11T00:12:00.000Z',
          decision: 'rejected',
          fallbackReview: null,
          requestId: 'request-git-discard-missing-repository',
          reviewId: item.review.id,
          store: new FsStore(),
          workspaceDb,
          workspaceId: item.review.workspaceId,
        })
      ).rejects.toThrow(/repository/i);
      expect(
        getWorkspaceSyncReview(workspaceDb, item.review.workspaceId, item.review.id)?.review.status
      ).toBe('pending');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('preserves a fallback branch whose commit lacks canonical review ownership', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-fallback-ownership-data-'));
    const repositoryRoot = mkdtempSync(
      join(tmpdir(), 'openkit-git-fallback-ownership-repository-')
    );
    temporaryRoots.push(dataRoot, repositoryRoot);
    const fallbackReview = gitRenameWorkspaceReviewItem();
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Reject an unowned fallback branch');
    const workspaceId = turn.workspaceId;
    const reviewBranch = fallbackReview.review.staging.branch;
    if (!reviewBranch) {
      throw new Error('Fallback review fixture requires a review branch.');
    }

    execFileSync('git', ['init'], { cwd: repositoryRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'repository@example.invalid'], {
      cwd: repositoryRoot,
    });
    execFileSync('git', ['config', 'user.name', 'Repository User'], { cwd: repositoryRoot });
    writeFileSync(join(repositoryRoot, 'old.txt'), 'reviewed\n', 'utf8');
    execFileSync('git', ['add', 'old.txt'], { cwd: repositoryRoot });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryRoot });
    const initialBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['switch', '-c', reviewBranch], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: repositoryRoot });
    execFileSync('git', ['commit', '-m', 'Unowned fallback commit'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    const unownedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['switch', initialBranch], { cwd: repositoryRoot, stdio: 'ignore' });
    const item: ReturnType<typeof gitRenameWorkspaceReviewItem> = {
      ...fallbackReview,
      changeSet: {
        ...fallbackReview.changeSet,
        base: { ...fallbackReview.changeSet.base, commit: baseCommit },
        evidenceRefs: [{ kind: 'worker', ref: turn.id }],
        head: { ...fallbackReview.changeSet.head, commit: unownedCommit },
        workspaceId,
      },
      review: { ...fallbackReview.review, workspaceId },
    };
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      upsertWorkspaceRepositoryResource(workspaceDb, {
        displayName: 'Fallback ownership repository',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          stagingStrategy: 'review-branch',
        },
        localPath: repositoryRoot,
        resourceId: item.changeSet.resourceId,
        workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspaceId,
        workspaceId,
      });
      let decisionError: unknown = null;
      try {
        await decideWorkspaceSyncReview({
          decidedAt: '2026-07-11T00:12:30.000Z',
          decision: 'rejected',
          fallbackReview: item,
          requestId: 'request-git-fallback-ownership',
          reviewId: item.review.id,
          store,
          workspaceDb,
          workspaceId,
        });
      } catch (error) {
        decisionError = error;
      }
      let liveBranch: string | null = null;
      try {
        liveBranch = execFileSync('git', ['rev-parse', '--verify', reviewBranch], {
          cwd: repositoryRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {}

      expect.soft(decisionError).toBeInstanceOf(Error);
      expect.soft(liveBranch).toBe(unownedCommit);
      expect
        .soft(getWorkspaceSyncReview(workspaceDb, workspaceId, item.review.id)?.review.status)
        .not.toBe('rejected');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects branchless fallback acceptance for a review-branch repository', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-fallback-branchless-data-'));
    const repositoryRoot = mkdtempSync(
      join(tmpdir(), 'openkit-git-fallback-branchless-repository-')
    );
    temporaryRoots.push(dataRoot, repositoryRoot);
    const fallbackReview = gitRenameWorkspaceReviewItem();
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Reject a branchless fallback review');
    const workspaceId = turn.workspaceId;

    execFileSync('git', ['init'], { cwd: repositoryRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'repository@example.invalid'], {
      cwd: repositoryRoot,
    });
    execFileSync('git', ['config', 'user.name', 'Repository User'], { cwd: repositoryRoot });
    writeFileSync(join(repositoryRoot, 'old.txt'), 'reviewed\n', 'utf8');
    execFileSync('git', ['add', 'old.txt'], { cwd: repositoryRoot });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryRoot });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    const item: ReturnType<typeof gitRenameWorkspaceReviewItem> = {
      ...fallbackReview,
      changeSet: {
        ...fallbackReview.changeSet,
        base: { ...fallbackReview.changeSet.base, commit: baseCommit },
        evidenceRefs: [{ kind: 'worker', ref: turn.id }],
        workspaceId,
      },
      review: {
        ...fallbackReview.review,
        staging: { ...fallbackReview.review.staging, branch: null },
        workspaceId,
      },
    };
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      upsertWorkspaceRepositoryResource(workspaceDb, {
        displayName: 'Branchless fallback repository',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          stagingStrategy: 'review-branch',
        },
        localPath: repositoryRoot,
        resourceId: item.changeSet.resourceId,
        workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspaceId,
        workspaceId,
      });
      let decisionError: unknown = null;
      try {
        await decideWorkspaceSyncReview({
          decidedAt: '2026-07-11T00:12:45.000Z',
          decision: 'accepted',
          fallbackReview: item,
          requestId: 'request-git-fallback-branchless',
          reviewId: item.review.id,
          store,
          workspaceDb,
          workspaceId,
        });
      } catch (error) {
        decisionError = error;
      }

      expect.soft(decisionError).toBeInstanceOf(Error);
      expect
        .soft(
          execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repositoryRoot,
            encoding: 'utf8',
          }).trim()
        )
        .toBe(baseCommit);
      expect.soft(existsSync(join(repositoryRoot, 'old.txt'))).toBe(true);
      if (existsSync(join(repositoryRoot, 'old.txt'))) {
        expect.soft(readFileSync(join(repositoryRoot, 'old.txt'), 'utf8')).toBe('reviewed\n');
      }
      expect.soft(existsSync(join(repositoryRoot, 'new.txt'))).toBe(false);
      expect
        .soft(getWorkspaceSyncReview(workspaceDb, workspaceId, item.review.id)?.review.status)
        .not.toBe('accepted');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('retries fallback review-branch cleanup after decision persistence fails', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-git-fallback-discard-data-'));
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'openkit-git-fallback-discard-repository-'));
    temporaryRoots.push(dataRoot, repositoryRoot);
    const fallbackReview = gitRenameWorkspaceReviewItem();
    const { review, changeSet } = fallbackReview;
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Own the fallback review branch');
    const workspaceId = turn.workspaceId;
    const reviewBranch = review.staging.branch;
    if (!reviewBranch) {
      throw new Error('Fallback review fixture requires a review branch.');
    }

    execFileSync('git', ['init'], { cwd: repositoryRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'repository@example.invalid'], {
      cwd: repositoryRoot,
    });
    execFileSync('git', ['config', 'user.name', 'Repository User'], { cwd: repositoryRoot });
    writeFileSync(join(repositoryRoot, 'old.txt'), 'reviewed\n', 'utf8');
    execFileSync('git', ['add', 'old.txt'], { cwd: repositoryRoot });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryRoot });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    const unstagedItem: ReturnType<typeof gitRenameWorkspaceReviewItem> = {
      ...fallbackReview,
      changeSet: {
        ...changeSet,
        base: { ...changeSet.base, commit: baseCommit },
        evidenceRefs: [{ kind: 'worker', ref: turn.id }],
        workspaceId,
      },
      review: { ...review, workspaceId },
    };
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, workspaceId);
    applyScopedMigrations(workspaceDb);

    try {
      const repository = upsertWorkspaceRepositoryResource(workspaceDb, {
        displayName: 'Fallback review repository',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          stagingStrategy: 'review-branch',
        },
        localPath: repositoryRoot,
        resourceId: changeSet.resourceId,
        workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspaceId,
        workspaceId,
      });
      const stagedCommit = await stageGitWorkspaceReview({
        persistHead: () => {},
        repository,
        review: unstagedItem,
        store,
      });
      const item: ReturnType<typeof gitRenameWorkspaceReviewItem> = {
        ...unstagedItem,
        changeSet: {
          ...unstagedItem.changeSet,
          head: { ...unstagedItem.changeSet.head, commit: stagedCommit },
        },
      };
      expect(getWorkspaceSyncReview(workspaceDb, workspaceId, review.id)).toBeNull();
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER fail_workspace_review_decision
        BEFORE UPDATE OF status ON staged_workspace_reviews
        BEGIN
          SELECT RAISE(ABORT, 'injected workspace review decision failure');
        END
      `);
      const input = {
        decidedAt: '2026-07-11T00:13:00.000Z',
        decision: 'rejected' as const,
        fallbackReview: item,
        requestId: 'request-git-fallback-discard-retry',
        reviewId: review.id,
        store,
        workspaceDb,
        workspaceId,
      };

      await expect(decideWorkspaceSyncReview(input)).rejects.toThrow(
        /injected workspace review decision failure/i
      );
      expect(
        execFileSync('git', ['rev-parse', reviewBranch], {
          cwd: repositoryRoot,
          encoding: 'utf8',
        }).trim()
      ).toBe(stagedCommit);

      workspaceDb.sqlite.exec('DROP TRIGGER fail_workspace_review_decision');
      await expect(decideWorkspaceSyncReview(input)).resolves.toMatchObject({
        review: { id: review.id, status: 'rejected' },
      });

      expect(() =>
        execFileSync('git', ['rev-parse', '--verify', reviewBranch], {
          cwd: repositoryRoot,
          stdio: 'ignore',
        })
      ).toThrow();
      expect(getWorkspaceSyncReview(workspaceDb, workspaceId, review.id)?.review.status).toBe(
        'rejected'
      );
    } finally {
      workspaceDb.sqlite.close();
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
