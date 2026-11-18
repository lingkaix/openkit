// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
} from '../runtime/filesystem-workspace-sync.js';
import { stageWorkspaceChangeSet } from '../runtime/workspace-materializer.js';
import {
  getWorkspaceSyncReview,
  recordWorkspaceSyncReview,
} from '../runtime/workspace-sync-records.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { openWorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

const timestamp = '2026-07-08T00:00:00.000Z';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('filesystem binary review classification', () => {
  it('classifies an oversized path without reading its bytes', async () => {
    const beforeRootPath = await mkdtemp(join(tmpdir(), 'openkit-large-before-'));
    const afterRootPath = await mkdtemp(join(tmpdir(), 'openkit-large-after-'));
    try {
      await writeFile(join(afterRootPath, 'large.bin'), Buffer.alloc(1024 * 1024 + 1));
      const common = {
        createdAt: timestamp,
        resourceId: 'fs_default',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      };
      const before = await createFilesystemSnapshotManifest({
        ...common,
        rootPath: beforeRootPath,
      });
      const after = await createFilesystemSnapshotManifest({ ...common, rootPath: afterRootPath });
      vi.mocked(readFile).mockClear();
      const changeSet = await buildFilesystemWorkspaceChangeSet({
        before,
        after,
        beforeRootPath,
        afterRootPath,
        changeSetId: 'wcs_large_no_read',
        inputSnapshotId: 'wis_large_no_read',
        materializationRecordId: 'wmr_large_no_read',
        createdAt: timestamp,
      });
      expect(readFile).not.toHaveBeenCalled();
      expect(changeSet.changedPaths).toMatchObject([
        {
          path: 'large.bin',
          binary: true,
          binaryReview: {
            mode: 'artifact-only',
            reason: 'binary-payload-too-large',
            bytes: after.entries[0]!.size,
            digest: after.entries[0]!.digest,
            mediaType: 'application/octet-stream',
          },
        },
      ]);
    } finally {
      await rm(beforeRootPath, { recursive: true, force: true });
      await rm(afterRootPath, { recursive: true, force: true });
    }
  });

  it.each([
    ['nul', Buffer.from('text\0payload'), 'binary-path'],
    ['invalid-utf8', Buffer.from([0xc3, 0x28]), 'binary-path'],
    ['control', Buffer.from([1, 2, 3]), 'binary-path'],
    ['large-text', Buffer.alloc(1024 * 1024 + 1, 0x61), 'binary-payload-too-large'],
    ['large-binary', Buffer.alloc(1024 * 1024 + 1), 'binary-payload-too-large'],
    ['utf8', Buffer.from('Valid UTF-8: café\n\t'), null],
    ['threshold', Buffer.alloc(1024 * 1024, 0x61), null],
  ] as const)(
    'classifies %s for every filesystem change status',
    async (_name, content, reason) => {
      const beforeRootPath = await mkdtemp(join(tmpdir(), 'openkit-binary-before-'));
      const afterRootPath = await mkdtemp(join(tmpdir(), 'openkit-binary-after-'));
      try {
        for (const path of ['deleted.dat', 'modified.dat', 'mode.dat']) {
          await writeFile(join(beforeRootPath, path), path === 'modified.dat' ? 'old\n' : content);
          await chmod(join(beforeRootPath, path), 0o644);
        }
        for (const path of ['added.dat', 'modified.dat', 'mode.dat']) {
          await writeFile(join(afterRootPath, path), content);
          await chmod(join(afterRootPath, path), path === 'mode.dat' ? 0o600 : 0o644);
        }
        const common = {
          createdAt: timestamp,
          resourceId: 'fs_default',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        };
        const before = await createFilesystemSnapshotManifest({
          ...common,
          rootPath: beforeRootPath,
        });
        const after = await createFilesystemSnapshotManifest({
          ...common,
          rootPath: afterRootPath,
        });
        const changeSet = await buildFilesystemWorkspaceChangeSet({
          before,
          after,
          beforeRootPath,
          afterRootPath,
          changeSetId: 'wcs_binary',
          inputSnapshotId: 'wis_binary',
          materializationRecordId: 'wmr_binary',
          createdAt: timestamp,
        });
        expect(changeSet.changedPaths.map((entry) => entry.status)).toEqual([
          'added',
          'deleted',
          'mode_changed',
          'modified',
        ]);
        for (const entry of changeSet.changedPaths) {
          expect(entry.binary).toBe(reason !== null);
          expect(entry.size).toBe(content.length);
          expect(entry.digest).toBe(`sha256:${createHash('sha256').update(content).digest('hex')}`);
          if (reason) {
            expect(entry.binaryReview).toMatchObject({
              mode: 'artifact-only',
              reason,
              digest: entry.digest,
              bytes: content.length,
              mediaType: 'application/octet-stream',
            });
            expect(entry.binaryReview?.summary.length).toBeGreaterThan(0);
          } else {
            expect(entry.binaryReview).toBeUndefined();
          }
        }
        const review = stageWorkspaceChangeSet(changeSet, {
          reviewId: 'swr_binary',
          stagingRef: 'staging://binary',
          createdAt: timestamp,
          patchPayload: null,
        });
        expect(
          review.validation.filter((entry) => entry.command === 'workspace.binary_artifact_only')
        ).toHaveLength(reason ? 4 : 0);
        const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-binary-readback-'));
        let db = openWorkspaceDb(dataRoot, changeSet.workspaceId);
        try {
          applyScopedMigrations(db);
          const item = {
            artifactId: 'ar_00000000-0000-7000-8000-000000000001',
            changeSet,
            review,
            patchPayload: null,
          };
          recordTestWorkspaceReviewMaterialization(db, item);
          recordWorkspaceSyncReview(db, { item });
          db.sqlite.close();
          db = openWorkspaceDb(dataRoot, changeSet.workspaceId);
          const readback = getWorkspaceSyncReview(db, changeSet.workspaceId, review.id);
          expect(readback?.changeSet.changedPaths).toEqual(changeSet.changedPaths);
          expect(readback?.review.validation).toEqual(review.validation);
        } finally {
          db.sqlite.close();
          await rm(dataRoot, { recursive: true, force: true });
        }
      } finally {
        await rm(beforeRootPath, { recursive: true, force: true });
        await rm(afterRootPath, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['binary', Buffer.from('old\0bytes')],
    ['oversized', Buffer.alloc(1024 * 1024 + 1, 0x61)],
  ] as const)(
    'keeps artifact-only review when the %s old version becomes text',
    async (_name, oldContent) => {
      const beforeRootPath = await mkdtemp(join(tmpdir(), 'openkit-old-binary-'));
      const afterRootPath = await mkdtemp(join(tmpdir(), 'openkit-new-text-'));
      try {
        await writeFile(join(beforeRootPath, 'file'), oldContent);
        await writeFile(join(afterRootPath, 'file'), 'new text\n');
        const common = {
          createdAt: timestamp,
          resourceId: 'fs_default',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        };
        const before = await createFilesystemSnapshotManifest({
          ...common,
          rootPath: beforeRootPath,
        });
        const after = await createFilesystemSnapshotManifest({
          ...common,
          rootPath: afterRootPath,
        });
        const changeSet = await buildFilesystemWorkspaceChangeSet({
          before,
          after,
          beforeRootPath,
          afterRootPath,
          changeSetId: 'wcs_old_binary',
          inputSnapshotId: 'wis_old_binary',
          materializationRecordId: 'wmr_old_binary',
          createdAt: timestamp,
        });
        expect(changeSet.changedPaths[0]).toMatchObject({
          binary: true,
          binaryReview: {
            mode: 'artifact-only',
            reason: _name === 'binary' ? 'binary-path' : 'binary-payload-too-large',
            bytes: 9,
            mediaType: 'text/plain',
          },
        });
      } finally {
        await rm(beforeRootPath, { recursive: true, force: true });
        await rm(afterRootPath, { recursive: true, force: true });
      }
    }
  );

  it.each(
    (['before', 'after'] as const).flatMap((side) =>
      (['stale', 'missing'] as const).map((fault) => ({ side, fault }))
    )
  )(
    'refuses $fault $side bytes for this build and permits a fresh retry',
    async ({ side, fault }) => {
      const beforeRootPath = await mkdtemp(join(tmpdir(), 'openkit-stale-before-'));
      const afterRootPath = await mkdtemp(join(tmpdir(), 'openkit-stale-after-'));
      try {
        await writeFile(join(beforeRootPath, 'file'), 'before\n');
        await writeFile(join(afterRootPath, 'file'), 'after\n');
        const common = {
          createdAt: timestamp,
          resourceId: 'fs_default',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        };
        const before = await createFilesystemSnapshotManifest({
          ...common,
          rootPath: beforeRootPath,
        });
        const after = await createFilesystemSnapshotManifest({
          ...common,
          rootPath: afterRootPath,
        });
        const affectedFile = join(side === 'before' ? beforeRootPath : afterRootPath, 'file');
        if (fault === 'missing') await rm(affectedFile);
        else await writeFile(affectedFile, 'stale\0bytes');
        const input = {
          before,
          after,
          beforeRootPath,
          afterRootPath,
          changeSetId: 'wcs_stale',
          inputSnapshotId: 'wis_stale',
          materializationRecordId: 'wmr_stale',
          createdAt: timestamp,
        };
        await expect(buildFilesystemWorkspaceChangeSet(input)).rejects.toMatchObject({
          code: 'workspace_sync_review_failed',
          status: 409,
          message: expect.stringMatching(/Capture fresh.*retry/),
        });
        await writeFile(affectedFile, side === 'before' ? 'before\n' : 'after\n');
        const retry = await buildFilesystemWorkspaceChangeSet(input);
        expect(retry.changedPaths).toMatchObject([
          { path: 'file', binary: false, status: 'modified' },
        ]);
      } finally {
        await rm(beforeRootPath, { recursive: true, force: true });
        await rm(afterRootPath, { recursive: true, force: true });
      }
    }
  );
});
