import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb, openWorkspaceReadDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as filesystemSync from './filesystem-workspace-sync.js';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from './filesystem-workspace-sync.js';
import * as applyPlans from './workspace-apply-plans.js';
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

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
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
  for (const { title, point: revocationPoint, decision } of [
    {
      title: 'denies a fresh accepted decision after its authenticated user is disabled',
      point: 'before decision',
      decision: 'accepted',
    },
    {
      title:
        'denies a fresh accepted decision after its authenticated user is disabled after native open',
      point: 'after native open',
      decision: 'accepted',
    },
    {
      title:
        'denies a fresh accepted decision after its authenticated user is disabled after Plan ACK',
      point: 'after Plan ACK',
      decision: 'accepted',
    },
    {
      title:
        'denies a fresh rejected decision when its authenticated user is disabled after native open',
      point: 'after native open',
      decision: 'rejected',
    },
  ] as const) {
    it(title, async () => {
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
      const workspaceId = 'ws_00000000-0000-769d-bfe1-5a67ada4aec2';
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
      const store = new FsStore({ dataRoot });
      const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      try {
        const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
          artifactId: 'ar_00000000-0000-761d-a0e1-b821a3910378',
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
        // Preserve every logical row: a refused fresh decision must publish no terminal or Audit.
        const rows = () => {
          const tables = workspaceDb.sqlite
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .all() as { name: string }[];
          return Object.fromEntries(
            tables.map(({ name }) => [
              name,
              workspaceDb.sqlite
                .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                .all()
                .map((row) => JSON.stringify(row))
                .sort(),
            ])
          );
        };
        const pendingRows = decision === 'rejected' ? rows() : undefined;
        let revoked = false;
        const disableUser = () => {
          coreDb.sqlite.transaction(() => {
            disableCanonicalUser(coreDb, LOCAL_USER_ID, new Date(timestamp));
          })();
          revoked = true;
        };
        const filesystemApply = vi.spyOn(filesystemSync, 'applyStagedFilesystemChanges');
        if (revocationPoint === 'before decision') {
          disableUser();
        } else if (revocationPoint === 'after native open') {
          const client = getControlStoreWorkerClient();
          const open = client.open.bind(client);
          vi.spyOn(client, 'open').mockImplementation(async (...args) => {
            await open(...args);
            disableUser();
          });
        } else {
          const record = applyPlans.recordWorkspaceApplyPlan;
          vi.spyOn(applyPlans, 'recordWorkspaceApplyPlan').mockImplementation(async (...args) => {
            // Call the real owner; revoke only after its original persistence acknowledgement.
            const plan = await record(...args);
            disableUser();
            return plan;
          });
        }

        await expect(
          decideWorkspaceSyncReview({
            authorityActor: LOCAL_AUTHORITY_ACTOR,
            coreDb,
            decidedAt: timestamp,
            decision,
            requestId: 'request-workspace-review-disabled-user',
            reviewId,
            store,
            workspaceDb,
            workspaceId,
          })
        ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });
        expect(readFileSync(join(targetRoot, 'review.txt'), 'utf8')).toBe('before\n');
        expect(revoked).toBe(true);
        // Review And Apply: failed authority handoff never enters the filesystem owner.
        expect(filesystemApply).not.toHaveBeenCalled();
        if (revocationPoint === 'after Plan ACK') {
          expect(listWorkspaceApplyPlans(workspaceDb, workspaceId)).toEqual([
            expect.objectContaining({
              id: `wap_${reviewId}`,
              reviewId,
              changeSetId: changeSet.id,
              createdAt: timestamp,
            }),
          ]);
        } else {
          expect(listWorkspaceApplyPlans(workspaceDb, workspaceId)).toEqual([]);
        }
        expect(listWorkspaceApplyResults(workspaceDb, workspaceId)).toEqual([]);
        expect(getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId)?.review.status).toBe(
          'pending'
        );
        if (pendingRows) {
          expect(getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId)).toEqual(item);
          expect(rows()).toEqual(pendingRows);
        }
      } finally {
        workspaceDb.sqlite.close();
        coreDb.sqlite.close();
      }
    });
  }

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

    const workspaceId = testEntityId('ws', `ws_filesystem_lineage_${suffix}`);
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
    const store = new FsStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
    try {
      const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
        artifactId: testEntityId('ar', `ar_filesystem_lineage_${suffix}`),
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
          workspaceId:
            lineageField === 'workspaceId'
              ? 'ws_00000000-0000-71f5-922f-6fd42f52f580'
              : before.workspaceId,
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
          store,
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
          store,
          workspaceDb,
          workspaceId,
        });

        expect(retried.workspaceApplyResult?.appliedAt).toBe(timestamp);
        const attribution = workspaceDb.sqlite
          .prepare(
            "SELECT actor_json FROM audit_events WHERE action IN ('workspace.apply.finish', 'workspace.review.decide') ORDER BY action"
          )
          .all() as Array<{ actor_json: string }>;
        expect(attribution).toHaveLength(2);
        expect(attribution.map((row) => JSON.parse(row.actor_json))).toEqual([
          LOCAL_AUTHORITY_ACTOR,
          LOCAL_AUTHORITY_ACTOR,
        ]);
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
    const workspaceId = 'ws_00000000-0000-7553-924e-bb938cbfc088';
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
    const store = new FsStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

    try {
      const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
        artifactId: 'ar_00000000-0000-7152-ab29-57a54004fc5b',
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
        store,
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
    const store = new FsStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, item.review.workspaceId);
    applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

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
          store,
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

  for (const failAudit of [false, true]) {
    it(
      failAudit
        ? 'rolls back the native rejected decision when its original Audit fails'
        : 'publishes the native rejected decision and original Audit with query-only Main',
      async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-review-decision-native-tuple-'));
        temporaryRoots.push(dataRoot);
        const item = gitRenameWorkspaceReviewItem();
        const workspaceId = item.review.workspaceId;
        const coreDb = openAuthorizedCoreDb(dataRoot, workspaceId);
        const store = new FsStore({ dataRoot });
        let workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
        applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
        const decidedAt = '2026-07-11T00:12:00.000Z';
        const requestId = '00000000-0000-7000-8000-000000000171';
        const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
        const nativeOpen = {
          database: `workspace:${scope.path}`,
          path: scope.path,
          dataRoot,
          create: false,
          initialize: 'workspace' as const,
          productOwner: scope.owner,
          contentMount: scope.contentMount,
        };
        // Inspect all tables: a failed tuple must not hide a partial or unrelated mutation.
        const rows = () => {
          const tables = workspaceDb.sqlite
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .all() as { name: string }[];
          return Object.fromEntries(
            tables.map(({ name }) => [
              name,
              workspaceDb.sqlite
                .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                .all()
                .map((row) => JSON.stringify(row))
                .sort(),
            ])
          );
        };
        const command = {
          authorityActor: LOCAL_AUTHORITY_ACTOR,
          coreDb,
          decidedAt,
          decision: 'rejected' as const,
          requestId,
          reviewId: item.review.id,
          store,
          workspaceId,
        };
        try {
          recordTestWorkspaceReviewMaterialization(workspaceDb, item);
          recordWorkspaceSyncReview(workspaceDb, { item });
          if (failAudit) {
            // Deliberate fault after real owner setup; no successful durable row is fabricated.
            workspaceDb.sqlite.exec(`CREATE TRIGGER reject_review_decision_audit
              BEFORE INSERT ON audit_events
              WHEN NEW.action = 'workspace.review.decide'
              BEGIN SELECT RAISE(ABORT, 'review decision Audit fault'); END`);
          }
          await getControlStoreWorkerClient().open(nativeOpen);
          workspaceDb.sqlite.pragma('query_only = ON');
          expect(workspaceDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
          const before = rows();

          if (failAudit) {
            // Review And Apply: terminal Review and its original Audit are one SQL tuple.
            await expect(decideWorkspaceSyncReview({ ...command, workspaceDb })).rejects.toThrow();
            expect(rows()).toEqual(before);
            expect(getWorkspaceSyncReview(workspaceDb, workspaceId, item.review.id)).toEqual(item);
            await shutdownControlStoreWorkerClient();
            workspaceDb.sqlite.close();
            workspaceDb = openWorkspaceReadDb(dataRoot, workspaceId);
            expect(workspaceDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
            expect(rows()).toEqual(before);
            // Remove only the injected fault while no native writer exists, then retry unchanged.
            workspaceDb.sqlite.close();
            workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
            workspaceDb.sqlite.exec('DROP TRIGGER reject_review_decision_audit');
            await getControlStoreWorkerClient().open(nativeOpen);
            workspaceDb.sqlite.pragma('query_only = ON');
          }

          // Expected RED before the tuple move: the real command writes through query-only Main.
          const expectedReview = { ...item.review, status: 'rejected', updatedAt: decidedAt };
          await expect(decideWorkspaceSyncReview({ ...command, workspaceDb })).resolves.toEqual({
            review: expectedReview,
            workspaceApplyResult: null,
          });
          expect(workspaceDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
          expect(getWorkspaceSyncReview(workspaceDb, workspaceId, item.review.id)).toEqual({
            ...item,
            review: expectedReview,
          });
          expect(
            workspaceDb.sqlite
              .prepare(`SELECT action, actor_json, request_id, resource,
              outcome, occurred_at FROM audit_events WHERE request_id = ?`)
              .all(requestId)
          ).toEqual([
            {
              action: 'workspace.review.decide',
              actor_json: JSON.stringify(LOCAL_AUTHORITY_ACTOR),
              request_id: requestId,
              resource: `workspace-review:${item.review.id}`,
              outcome: 'succeeded',
              occurred_at: decidedAt,
            },
          ]);
          const committed = rows();
          expect(committed.audit_events).toHaveLength(before.audit_events.length + 1);
          expect(committed.audit_events).toEqual(expect.arrayContaining(before.audit_events));
          expect({
            ...committed,
            staged_workspace_reviews: before.staged_workspace_reviews,
            audit_events: before.audit_events,
          }).toEqual(before);
          expect(listWorkspaceApplyPlans(workspaceDb, workspaceId)).toEqual([]);
          expect(listWorkspaceApplyResults(workspaceDb, workspaceId)).toEqual([]);
          // A committed terminal replay retains its existing read-only semantics after user disable.
          if (!failAudit) {
            coreDb.sqlite.transaction(() => {
              disableCanonicalUser(coreDb, LOCAL_USER_ID, new Date(decidedAt));
            })();
          }
          // A matching terminal replay is read-only, including original Audit identity and bytes.
          await expect(
            decideWorkspaceSyncReview({
              ...command,
              workspaceDb,
              requestId: 'request-native-review-replay',
            })
          ).resolves.toEqual({ review: expectedReview, workspaceApplyResult: null });
          expect(rows()).toEqual(committed);
          await expect(
            decideWorkspaceSyncReview({
              ...command,
              workspaceDb,
              decision: 'blocked',
            })
          ).rejects.toMatchObject({ code: 'workspace_sync_review_failed', status: 404 });
          expect(rows()).toEqual(committed);
          // The result must survive writer shutdown and a new read-only SQLite connection.
          await shutdownControlStoreWorkerClient();
          workspaceDb.sqlite.close();
          workspaceDb = openWorkspaceReadDb(dataRoot, workspaceId);
          expect(workspaceDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
          expect(rows()).toEqual(committed);
        } finally {
          await shutdownControlStoreWorkerClient();
          if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
          coreDb.sqlite.close();
        }
      }
    );
  }

  it('does not create a durable review from an artifact fallback', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-review-fallback-data-'));
    temporaryRoots.push(dataRoot);
    const fallbackReview = gitRenameWorkspaceReviewItem();
    const workspaceId = fallbackReview.review.workspaceId;
    const coreDb = openAuthorizedCoreDb(dataRoot, workspaceId);
    const store = new FsStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

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
          store,
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
    artifactId: 'ar_00000000-0000-7b85-a7e1-7b8573fc52b8',
    changeSet: {
      artifactIds: ['ar_00000000-0000-7b85-a7e1-7b8573fc52b8'],
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
      evidenceRefs: [{ kind: 'worker', ref: 'tu_00000000-0000-71b5-836c-13a89c2c15f8' }],
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
      workspaceId: 'ws_00000000-0000-7322-86eb-6ad8930b9033',
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
      workspaceId: 'ws_00000000-0000-7322-86eb-6ad8930b9033',
    },
  };
}
