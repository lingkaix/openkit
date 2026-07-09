import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyStagedFilesystemChanges,
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from './filesystem-workspace-sync.js';

/** Creates one isolated filesystem workspace root. */
function createRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

describe('filesystem workspace synchronization', () => {
  it('creates content-addressed manifests, stages changed files, and applies them safely', async () => {
    const targetRoot = createRoot('openkit-fs-target-');
    const workerRoot = createRoot('openkit-fs-worker-');
    const stagingRoot = createRoot('openkit-fs-staging-');
    const timestamp = '2026-06-27T12:00:00.000Z';

    await mkdir(join(targetRoot, 'docs'), { recursive: true });
    await mkdir(join(workerRoot, 'docs'), { recursive: true });
    await writeFile(join(targetRoot, 'docs', 'guide.md'), '# Guide\n');
    await writeFile(join(targetRoot, 'old.txt'), 'remove me\n');
    await writeFile(join(workerRoot, 'docs', 'guide.md'), '# Guide\n\nUpdated.\n');
    await writeFile(join(workerRoot, 'new.txt'), 'new file\n');

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId: 'ws_demo',
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId: 'ws_demo',
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_fs_1',
      createdAt: timestamp,
      inputSnapshotId: 'wis_fs_1',
      materializationRecordId: 'wmr_fs_1',
    });
    const staged = await stageFilesystemWorkspaceChanges({
      changeSet,
      sourceRoot: workerRoot,
      stagingRoot,
    });
    const result = await applyStagedFilesystemChanges({
      appliedAt: timestamp,
      before,
      changeSet,
      reviewId: 'swr_fs_1',
      stagingRoot,
      targetRoot,
      workspaceId: 'ws_demo',
    });

    expect(before.contentDigest).toMatch(/^sha256:/);
    expect(after.contentDigest).toMatch(/^sha256:/);
    expect(changeSet).toMatchObject({
      base: { commit: null, contentDigest: before.contentDigest },
      changedPaths: [
        { path: 'docs/guide.md', status: 'modified' },
        { path: 'new.txt', status: 'added' },
        { path: 'old.txt', status: 'deleted' },
      ],
      head: { commit: null, contentDigest: after.contentDigest },
      patch: null,
      strategy: 'filesystem',
    });
    expect(staged.stagedPaths).toEqual(['docs/guide.md', 'new.txt']);
    expect(readFileSync(join(targetRoot, 'docs', 'guide.md'), 'utf8')).toBe(
      '# Guide\n\nUpdated.\n'
    );
    expect(readFileSync(join(targetRoot, 'new.txt'), 'utf8')).toBe('new file\n');
    expect(existsSync(join(targetRoot, 'old.txt'))).toBe(false);
    expect(result).toMatchObject({
      appliedPaths: ['docs/guide.md', 'new.txt', 'old.txt'],
      status: 'applied',
    });
  });

  it('detects conflicts before applying staged filesystem changes', async () => {
    const targetRoot = createRoot('openkit-fs-target-conflict-');
    const workerRoot = createRoot('openkit-fs-worker-conflict-');
    const stagingRoot = createRoot('openkit-fs-staging-conflict-');
    const timestamp = '2026-06-27T12:05:00.000Z';

    await writeFile(join(targetRoot, 'notes.txt'), 'base\n');
    await writeFile(join(workerRoot, 'notes.txt'), 'worker\n');

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId: 'ws_demo',
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId: 'ws_demo',
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_fs_conflict',
      createdAt: timestamp,
      inputSnapshotId: 'wis_fs_1',
      materializationRecordId: 'wmr_fs_1',
    });

    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
    writeFileSync(join(targetRoot, 'notes.txt'), 'human edit\n');

    const result = await applyStagedFilesystemChanges({
      appliedAt: timestamp,
      before,
      changeSet,
      reviewId: 'swr_fs_conflict',
      stagingRoot,
      targetRoot,
      workspaceId: 'ws_demo',
    });

    expect(result).toMatchObject({
      appliedPaths: [],
      conflictRecords: [expect.stringContaining('notes.txt')],
      status: 'conflicted',
    });
    expect(readFileSync(join(targetRoot, 'notes.txt'), 'utf8')).toBe('human edit\n');

    await rm(targetRoot, { force: true, recursive: true });
    await rm(workerRoot, { force: true, recursive: true });
    await rm(stagingRoot, { force: true, recursive: true });
  });

  it('reports a conflict when a target file becomes a directory before filesystem apply', async () => {
    const targetRoot = createRoot('openkit-fs-target-kind-conflict-');
    const workerRoot = createRoot('openkit-fs-worker-kind-conflict-');
    const stagingRoot = createRoot('openkit-fs-staging-kind-conflict-');
    const timestamp = '2026-06-27T12:06:00.000Z';

    await mkdir(join(targetRoot, 'docs'), { recursive: true });
    await mkdir(join(workerRoot, 'docs'), { recursive: true });
    await writeFile(join(targetRoot, 'docs', 'guide.md'), 'base\n');
    await writeFile(join(workerRoot, 'docs', 'guide.md'), 'worker\n');

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId: 'ws_demo',
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId: 'ws_demo',
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_fs_kind_conflict',
      createdAt: timestamp,
      inputSnapshotId: 'wis_fs_kind_conflict',
      materializationRecordId: 'wmr_fs_kind_conflict',
    });

    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
    await rm(join(targetRoot, 'docs', 'guide.md'));
    await mkdir(join(targetRoot, 'docs', 'guide.md'));

    const result = await applyStagedFilesystemChanges({
      appliedAt: timestamp,
      before,
      changeSet,
      reviewId: 'swr_fs_kind_conflict',
      stagingRoot,
      targetRoot,
      workspaceId: 'ws_demo',
    });

    expect(result).toMatchObject({
      appliedPaths: [],
      conflictRecords: ['Target path is not a file: docs/guide.md'],
      skippedPaths: ['docs/guide.md'],
      status: 'conflicted',
    });
    expect((await stat(join(targetRoot, 'docs', 'guide.md'))).isDirectory()).toBe(true);

    await rm(targetRoot, { force: true, recursive: true });
    await rm(workerRoot, { force: true, recursive: true });
    await rm(stagingRoot, { force: true, recursive: true });
  });

  it('reports a conflict when an added file parent is occupied before filesystem apply', async () => {
    const targetRoot = createRoot('openkit-fs-target-parent-conflict-');
    const workerRoot = createRoot('openkit-fs-worker-parent-conflict-');
    const stagingRoot = createRoot('openkit-fs-staging-parent-conflict-');
    const timestamp = '2026-06-27T12:06:30.000Z';

    await mkdir(join(workerRoot, 'docs'), { recursive: true });
    await writeFile(join(workerRoot, 'docs', 'guide.md'), 'worker\n');

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId: 'ws_demo',
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId: 'ws_demo',
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_fs_parent_conflict',
      createdAt: timestamp,
      inputSnapshotId: 'wis_fs_parent_conflict',
      materializationRecordId: 'wmr_fs_parent_conflict',
    });

    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
    await writeFile(join(targetRoot, 'docs'), 'not a directory\n');

    const result = await applyStagedFilesystemChanges({
      appliedAt: timestamp,
      before,
      changeSet,
      reviewId: 'swr_fs_parent_conflict',
      stagingRoot,
      targetRoot,
      workspaceId: 'ws_demo',
    });

    expect(result).toMatchObject({
      appliedPaths: [],
      conflictRecords: ['Target parent is not a directory: docs'],
      skippedPaths: ['docs/guide.md'],
      status: 'conflicted',
    });
    expect(readFileSync(join(targetRoot, 'docs'), 'utf8')).toBe('not a directory\n');

    await rm(targetRoot, { force: true, recursive: true });
    await rm(workerRoot, { force: true, recursive: true });
    await rm(stagingRoot, { force: true, recursive: true });
  });

  it('detects and applies filesystem permission-only changes', async () => {
    const targetRoot = createRoot('openkit-fs-target-mode-');
    const workerRoot = createRoot('openkit-fs-worker-mode-');
    const stagingRoot = createRoot('openkit-fs-staging-mode-');
    const timestamp = '2026-06-27T12:07:00.000Z';

    await writeFile(join(targetRoot, 'script.sh'), '#!/bin/sh\necho demo\n');
    await writeFile(join(workerRoot, 'script.sh'), '#!/bin/sh\necho demo\n');
    await chmod(join(targetRoot, 'script.sh'), 0o644);
    await chmod(join(workerRoot, 'script.sh'), 0o755);

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId: 'ws_demo',
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId: 'ws_demo',
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_fs_mode',
      createdAt: timestamp,
      inputSnapshotId: 'wis_fs_mode',
      materializationRecordId: 'wmr_fs_mode',
    });

    expect(changeSet.changedPaths).toEqual([
      {
        binary: false,
        digest: expect.stringMatching(/^sha256:/),
        newPermissions: '0755',
        oldPermissions: '0644',
        path: 'script.sh',
        size: 20,
        status: 'mode_changed',
      },
    ]);

    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
    const result = await applyStagedFilesystemChanges({
      appliedAt: timestamp,
      before,
      changeSet,
      reviewId: 'swr_fs_mode',
      stagingRoot,
      targetRoot,
      workspaceId: 'ws_demo',
    });

    expect(result).toMatchObject({
      appliedPaths: ['script.sh'],
      status: 'applied',
    });
    expect((await stat(join(targetRoot, 'script.sh'))).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(targetRoot, 'script.sh'), 'utf8')).toBe('#!/bin/sh\necho demo\n');

    await rm(targetRoot, { force: true, recursive: true });
    await rm(workerRoot, { force: true, recursive: true });
    await rm(stagingRoot, { force: true, recursive: true });
  });

  it('rejects filesystem staging through symlink directory escapes', async () => {
    const workerRoot = createRoot('openkit-fs-worker-symlink-');
    const stagingRoot = createRoot('openkit-fs-staging-symlink-');
    const outsideRoot = createRoot('openkit-fs-outside-symlink-');
    const timestamp = '2026-06-27T12:10:00.000Z';

    await mkdir(join(outsideRoot, 'outside'), { recursive: true });
    await symlink(outsideRoot, join(stagingRoot, 'docs'), 'dir');
    await mkdir(join(workerRoot, 'docs'), { recursive: true });
    await writeFile(join(workerRoot, 'docs', 'escape.txt'), 'must not escape\n');

    await expect(
      stageFilesystemWorkspaceChanges({
        changeSet: {
          artifactIds: [],
          base: { commit: null, contentDigest: 'sha256:before' },
          bundle: null,
          changedPaths: [{ path: 'docs/escape.txt', status: 'added' }],
          createdAt: timestamp,
          evidenceRefs: [],
          head: { commit: null, contentDigest: 'sha256:after' },
          id: 'wcs_fs_symlink_escape',
          inputSnapshotId: 'wis_fs_symlink_escape',
          materializationRecordId: 'wmr_fs_symlink_escape',
          patch: null,
          redaction: { notes: [], status: 'no-sensitive-content-found' },
          resourceId: 'fs_default',
          strategy: 'filesystem',
          workspaceId: 'ws_demo',
        },
        sourceRoot: workerRoot,
        stagingRoot,
      })
    ).rejects.toThrow('unsafe filesystem path');
    expect(existsSync(join(outsideRoot, 'escape.txt'))).toBe(false);

    await rm(workerRoot, { force: true, recursive: true });
    await rm(stagingRoot, { force: true, recursive: true });
    await rm(outsideRoot, { force: true, recursive: true });
  });
});
