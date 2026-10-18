// openkit-test-platform: posix
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import type { FilesystemSnapshotManifest } from './filesystem-workspace-sync.js';
import {
  getFilesystemWorkspaceStagingRoot,
  type RecordFilesystemWorkspaceStagingRootInput,
  recordFilesystemWorkspaceStagingRoot,
} from './workspace-filesystem-staging.js';

describe('filesystem workspace staging roots', () => {
  it('stores v1 canonical root identities and rejects replay after a root is replaced', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-filesystem-staging-'));
    onTestFinished(() => rmSync(fixtureRoot, { force: true, recursive: true }));
    const dataRoot = join(fixtureRoot, 'data');
    const stagingRoot = join(fixtureRoot, 'staging');
    const stagingRootAlias = join(fixtureRoot, 'staging-alias');
    const targetRoot = join(fixtureRoot, 'target');
    const targetRootAlias = join(fixtureRoot, 'target-alias');
    mkdirSync(dataRoot);
    mkdirSync(stagingRoot);
    mkdirSync(targetRoot);
    symlinkSync(stagingRoot, stagingRootAlias, 'dir');
    symlinkSync(targetRoot, targetRootAlias, 'dir');
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const before = {
      contentDigest: 'sha256:before',
      createdAt: '2026-07-05T00:00:00.000Z',
      entries: [],
      resourceId: 'fs_default',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      description: 'Retained snapshot annotation.',
    } satisfies FilesystemSnapshotManifest & { description: string };
    const baseline = {
      before,
      changeSetId: 'wcs_fs_1',
      createdAt: '2026-07-05T00:00:01.000Z',
      reviewId: 'swr_fs_1',
      stagingRootPath: stagingRootAlias,
      targetRootPath: targetRootAlias,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    } satisfies RecordFilesystemWorkspaceStagingRootInput;

    try {
      applyScopedMigrations(workspaceDb);
      const stored = recordFilesystemWorkspaceStagingRoot(workspaceDb, baseline);
      const storedRow = workspaceDb.sqlite
        .prepare(`SELECT schema_version AS schemaVersion, before_manifest_json AS payload
          FROM workspace_filesystem_staging_roots WHERE review_id = ?`)
        .get(baseline.reviewId);
      expect(storedRow).toMatchObject({ schemaVersion: 1 });
      expect(
        getFilesystemWorkspaceStagingRoot(workspaceDb, baseline.workspaceId, baseline.reviewId)
      ).toEqual(stored);
      expect(stored.before).toEqual(before);
      const stagingStats = statSync(stagingRoot, { bigint: true });
      const targetStats = statSync(targetRoot, { bigint: true });
      expect.soft(stored).toMatchObject({
        stagingRootIdentity: `${stagingStats.dev}:${stagingStats.ino}`,
        stagingRootPath: realpathSync(stagingRootAlias),
        targetRootIdentity: `${targetStats.dev}:${targetStats.ino}`,
        targetRootPath: realpathSync(targetRootAlias),
      });
      workspaceDb.sqlite.exec(`CREATE TRIGGER reject_filesystem_staging_update
        BEFORE UPDATE ON workspace_filesystem_staging_roots
        BEGIN
          SELECT RAISE(FAIL, 'exact staging replay performed an update');
        END`);

      expect(recordFilesystemWorkspaceStagingRoot(workspaceDb, baseline)).toEqual(stored);
      expect(
        workspaceDb.sqlite
          .prepare(`SELECT schema_version AS schemaVersion, before_manifest_json AS payload
          FROM workspace_filesystem_staging_roots WHERE review_id = ?`)
          .get(baseline.reviewId)
      ).toEqual(storedRow);

      const conflicts: readonly RecordFilesystemWorkspaceStagingRootInput[] = [
        { ...baseline, changeSetId: 'wcs_fs_2' },
        { ...baseline, createdAt: '2026-07-05T00:00:02.000Z' },
        { ...baseline, stagingRootPath: targetRootAlias },
        { ...baseline, targetRootPath: stagingRootAlias },
        { ...baseline, before: { ...before, contentDigest: 'sha256:different' } },
      ];

      for (const conflict of conflicts) {
        expect(() => recordFilesystemWorkspaceStagingRoot(workspaceDb, conflict)).toThrow(
          /conflict/i
        );
      }

      renameSync(stagingRoot, join(fixtureRoot, 'original-staging'));
      mkdirSync(stagingRoot);
      expect(() => recordFilesystemWorkspaceStagingRoot(workspaceDb, baseline)).toThrow(
        /conflict|identity/i
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('refuses an unknown staging version before payload decode or replay', () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), 'openkit-workspace-filesystem-staging-version-')
    );
    onTestFinished(() => rmSync(fixtureRoot, { force: true, recursive: true }));
    const dataRoot = join(fixtureRoot, 'data');
    const stagingRoot = join(fixtureRoot, 'staging');
    const targetRoot = join(fixtureRoot, 'target');
    mkdirSync(dataRoot);
    mkdirSync(stagingRoot);
    mkdirSync(targetRoot);
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    const input = {
      before: {
        contentDigest: 'sha256:before',
        createdAt: '2026-07-05T00:00:00.000Z',
        entries: [],
        resourceId: 'fs_default',
        workspaceId,
      },
      changeSetId: 'wcs_fs_1',
      createdAt: '2026-07-05T00:00:01.000Z',
      reviewId: 'swr_fs_1',
      stagingRootPath: stagingRoot,
      targetRootPath: targetRoot,
      workspaceId,
    } satisfies RecordFilesystemWorkspaceStagingRootInput;

    try {
      applyScopedMigrations(workspaceDb);
      recordFilesystemWorkspaceStagingRoot(workspaceDb, input);
      workspaceDb.sqlite
        .prepare(`UPDATE workspace_filesystem_staging_roots
        SET schema_version = 2, before_manifest_json = '{' WHERE review_id = ?`)
        .run(input.reviewId);

      expect(() =>
        getFilesystemWorkspaceStagingRoot(workspaceDb, workspaceId, input.reviewId)
      ).toThrow('Unsupported retained record format.');
      expect(() => recordFilesystemWorkspaceStagingRoot(workspaceDb, input)).toThrow(
        'Unsupported retained record format.'
      );
      expect(
        workspaceDb.sqlite
          .prepare(`SELECT schema_version AS schemaVersion, before_manifest_json AS payload
          FROM workspace_filesystem_staging_roots WHERE review_id = ?`)
          .get(input.reviewId)
      ).toEqual({ schemaVersion: 2, payload: '{' });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
