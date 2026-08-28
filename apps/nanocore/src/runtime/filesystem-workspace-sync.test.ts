// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmod, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyStagedFilesystemChanges,
  buildFilesystemWorkspaceChangeSet,
  cleanupCommittedFilesystemRollback,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from './filesystem-workspace-sync.js';

/** Creates one isolated filesystem workspace root. */
function createRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

/** Creates and stages one modified or deleted single-file workspace fixture. */
async function createChangedFileFixture(name: string, workerContent: string | null) {
  const targetRoot = createRoot(`openkit-fs-target-${name}-`);
  const workerRoot = createRoot(`openkit-fs-worker-${name}-`);
  const stagingRoot = createRoot(`openkit-fs-staging-${name}-`);
  const timestamp = '2026-06-27T12:20:00.000Z';

  await writeFile(join(targetRoot, 'notes.txt'), 'base\n');
  await chmod(join(targetRoot, 'notes.txt'), 0o644);
  if (workerContent !== null) {
    await writeFile(join(workerRoot, 'notes.txt'), workerContent);
  }

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
    changeSetId: `wcs_fs_${name}`,
    createdAt: timestamp,
    inputSnapshotId: `wis_fs_${name}`,
    materializationRecordId: `wmr_fs_${name}`,
  });
  await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });

  return { before, changeSet, stagingRoot, targetRoot, timestamp, workerRoot };
}

/** Derives the private rollback root for one staged review. */
function rollbackRootFor(stagingRoot: string, reviewId: string, workspaceId = 'ws_demo'): string {
  return join(
    stagingRoot,
    `.openkit-workspace-rollback-${createHash('sha256')
      .update(`${workspaceId}\0${reviewId}`)
      .digest('hex')}`
  );
}

/** Derives the deterministic rollback preparation root for one staged review. */
function rollbackPreparationRootFor(
  stagingRoot: string,
  reviewId: string,
  workspaceId = 'ws_demo'
): string {
  return `${rollbackRootFor(stagingRoot, reviewId, workspaceId)}.prepare`;
}

/** Derives the operation-owned atomic replacement root for one reviewed path. */
function replacementRootFor(
  targetRoot: string,
  reviewId: string,
  relativePath: string,
  workspaceId = 'ws_demo'
): string {
  return join(
    targetRoot,
    dirname(relativePath),
    `.openkit-write-${createHash('sha256')
      .update(`${workspaceId}\0${reviewId}\0${relativePath}`)
      .digest('hex')}`
  );
}

/** Accepts one low-level apply result without external persistence. */
function ignoreApplyResult(): void {}

/** Returns one directory's device and inode identity. */
async function rootIdentity(path: string): Promise<string> {
  const stats = await stat(path, { bigint: true });
  return `${stats.dev}:${stats.ino}`;
}

/** Creates one rollback root with a complete ready marker and returns its root identities. */
async function createRollbackReadyFixture(input: {
  readonly changeSetId: string;
  readonly markerPatch?: Readonly<Record<string, unknown>>;
  readonly replacementPaths: readonly string[];
  readonly reviewId: string;
  readonly rollbackRoot: string;
  readonly stagingRoot: string;
  readonly targetRoot: string;
  readonly workspaceId: string;
}): Promise<{
  readonly stagingRootIdentity: string;
  readonly targetRootIdentity: string;
}> {
  const stagingRootIdentity = await rootIdentity(input.stagingRoot);
  const targetRootIdentity = await rootIdentity(input.targetRoot);
  const targetRealPath = await realpath(input.targetRoot);
  await mkdir(input.rollbackRoot, { recursive: true });
  await writeFile(
    join(input.rollbackRoot, 'ready.json'),
    `${JSON.stringify({
      changeSetId: input.changeSetId,
      replacementPaths: input.replacementPaths,
      reviewId: input.reviewId,
      stagingRootIdentity,
      targetRootDigest: `sha256:${createHash('sha256')
        .update(Buffer.from(targetRealPath))
        .digest('hex')}`,
      targetRootIdentity,
      version: 1,
      workspaceId: input.workspaceId,
      ...input.markerPatch,
    })}\n`
  );
  return { stagingRootIdentity, targetRootIdentity };
}

/** Creates a manually released promise gate for deterministic concurrency tests. */
function createPromiseGate(): { readonly open: () => void; readonly promise: Promise<void> } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
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
      persistResult: ignoreApplyResult,
      reviewId: 'swr_fs_1',
      stagingRoot,
      stagingRootIdentity: await rootIdentity(stagingRoot),
      targetRoot,
      targetRootIdentity: await rootIdentity(targetRoot),
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
      persistResult: ignoreApplyResult,
      reviewId: 'swr_fs_conflict',
      stagingRoot,
      stagingRootIdentity: await rootIdentity(stagingRoot),
      targetRoot,
      targetRootIdentity: await rootIdentity(targetRoot),
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
      persistResult: ignoreApplyResult,
      reviewId: 'swr_fs_kind_conflict',
      stagingRoot,
      stagingRootIdentity: await rootIdentity(stagingRoot),
      targetRoot,
      targetRootIdentity: await rootIdentity(targetRoot),
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
      persistResult: ignoreApplyResult,
      reviewId: 'swr_fs_parent_conflict',
      stagingRoot,
      stagingRootIdentity: await rootIdentity(stagingRoot),
      targetRoot,
      targetRootIdentity: await rootIdentity(targetRoot),
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
    const targetInode = (await stat(join(targetRoot, 'script.sh'))).ino;
    const result = await applyStagedFilesystemChanges({
      appliedAt: timestamp,
      before,
      changeSet,
      persistResult: ignoreApplyResult,
      reviewId: 'swr_fs_mode',
      stagingRoot,
      stagingRootIdentity: await rootIdentity(stagingRoot),
      targetRoot,
      targetRootIdentity: await rootIdentity(targetRoot),
      workspaceId: 'ws_demo',
    });

    expect(result).toMatchObject({
      appliedPaths: ['script.sh'],
      status: 'applied',
    });
    expect((await stat(join(targetRoot, 'script.sh'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(targetRoot, 'script.sh'))).ino).toBe(targetInode);
    expect(readFileSync(join(targetRoot, 'script.sh'), 'utf8')).toBe('#!/bin/sh\necho demo\n');

    await rm(targetRoot, { force: true, recursive: true });
    await rm(workerRoot, { force: true, recursive: true });
    await rm(stagingRoot, { force: true, recursive: true });
  });

  it('rejects all filesystem changes before mutation when a staged file is missing', async () => {
    const targetRoot = createRoot('openkit-fs-target-rollback-');
    const workerRoot = createRoot('openkit-fs-worker-rollback-');
    const stagingRoot = createRoot('openkit-fs-staging-rollback-');
    const timestamp = '2026-06-27T12:08:00.000Z';

    try {
      await writeFile(join(targetRoot, 'a-deleted.txt'), 'restore deleted file\n');
      await writeFile(join(targetRoot, 'b-updated.sh'), '#!/bin/sh\necho before\n');
      await writeFile(join(targetRoot, 'c-copy-fails.txt'), 'before failed copy\n');
      await writeFile(join(workerRoot, 'b-updated.sh'), '#!/bin/sh\necho after\n');
      await writeFile(join(workerRoot, 'c-copy-fails.txt'), 'after failed copy\n');
      await chmod(join(targetRoot, 'b-updated.sh'), 0o644);
      await chmod(join(workerRoot, 'b-updated.sh'), 0o755);

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
        changeSetId: 'wcs_fs_rollback',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_rollback',
        materializationRecordId: 'wmr_fs_rollback',
      });

      expect(changeSet.changedPaths.map(({ path }) => path)).toEqual([
        'a-deleted.txt',
        'b-updated.sh',
        'c-copy-fails.txt',
      ]);
      await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
      await rm(join(stagingRoot, 'c-copy-fails.txt'));

      const result = await applyStagedFilesystemChanges({
        appliedAt: timestamp,
        before,
        changeSet,
        persistResult: ignoreApplyResult,
        reviewId: 'swr_fs_rollback',
        stagingRoot,
        stagingRootIdentity: await rootIdentity(stagingRoot),
        targetRoot,
        targetRootIdentity: await rootIdentity(targetRoot),
        workspaceId: 'ws_demo',
      });

      expect(result).toMatchObject({ appliedPaths: [], status: 'conflicted' });
      expect(readFileSync(join(targetRoot, 'a-deleted.txt'), 'utf8')).toBe(
        'restore deleted file\n'
      );
      expect(readFileSync(join(targetRoot, 'b-updated.sh'), 'utf8')).toBe(
        '#!/bin/sh\necho before\n'
      );
      expect((await stat(join(targetRoot, 'b-updated.sh'))).mode & 0o777).toBe(0o644);
      expect(readFileSync(join(targetRoot, 'c-copy-fails.txt'), 'utf8')).toBe(
        'before failed copy\n'
      );
    } finally {
      await rm(targetRoot, { force: true, recursive: true });
      await rm(workerRoot, { force: true, recursive: true });
      await rm(stagingRoot, { force: true, recursive: true });
    }
  });

  it('removes apply-created parent directories when durable persistence rolls back', async () => {
    const targetRoot = createRoot('openkit-fs-target-directory-rollback-');
    const workerRoot = createRoot('openkit-fs-worker-directory-rollback-');
    const stagingRoot = createRoot('openkit-fs-staging-directory-rollback-');
    const timestamp = '2026-06-27T12:09:00.000Z';

    try {
      await mkdir(join(workerRoot, 'new', 'nested'), { recursive: true });
      await writeFile(join(workerRoot, 'new', 'nested', 'file.txt'), 'new file\n');
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
        changeSetId: 'wcs_fs_directory_rollback',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_directory_rollback',
        materializationRecordId: 'wmr_fs_directory_rollback',
      });
      await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });

      await expect(
        applyStagedFilesystemChanges({
          appliedAt: timestamp,
          before,
          changeSet,
          persistResult: () => {
            throw new Error('durable persistence failed');
          },
          reviewId: 'swr_fs_directory_rollback',
          stagingRoot,
          stagingRootIdentity: await rootIdentity(stagingRoot),
          targetRoot,
          targetRootIdentity: await rootIdentity(targetRoot),
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow('durable persistence failed');

      expect(existsSync(join(targetRoot, 'new'))).toBe(false);
    } finally {
      await rm(targetRoot, { force: true, recursive: true });
      await rm(workerRoot, { force: true, recursive: true });
      await rm(stagingRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'content',
    'empty',
  ] as const)('cleans only the rollback-proven atomic replacement %s orphan on retry', async (orphanState) => {
    const fixture = await createChangedFileFixture(`replacement_${orphanState}`, 'worker\n');
    const reviewId = `swr_fs_replacement_${orphanState}`;
    const relativePath = 'notes.txt';
    const ownedRoot = replacementRootFor(fixture.targetRoot, reviewId, relativePath);
    const rollbackRoot = rollbackRootFor(fixture.stagingRoot, reviewId);
    const otherReviewRoot = replacementRootFor(
      fixture.targetRoot,
      `${reviewId}_other`,
      relativePath
    );
    const otherPathRoot = replacementRootFor(fixture.targetRoot, reviewId, 'other.txt');
    const userRoot = join(fixture.targetRoot, '.openkit-write-user-data');

    try {
      const { stagingRootIdentity, targetRootIdentity } = await createRollbackReadyFixture({
        changeSetId: fixture.changeSet.id,
        replacementPaths: fixture.changeSet.changedPaths.map((entry) => entry.path),
        reviewId,
        rollbackRoot,
        stagingRoot: fixture.stagingRoot,
        targetRoot: fixture.targetRoot,
        workspaceId: 'ws_demo',
      });
      await mkdir(ownedRoot);
      if (orphanState === 'content') {
        await writeFile(join(ownedRoot, 'content'), 'partial worker content\n');
      }
      await mkdir(join(rollbackRoot, 'files'), { recursive: true });
      await writeFile(join(rollbackRoot, 'files', relativePath), 'base\n');
      for (const [root, sentinel] of [
        [otherReviewRoot, 'other review\n'],
        [otherPathRoot, 'other path\n'],
        [userRoot, 'user data\n'],
      ] as const) {
        await mkdir(root);
        await writeFile(join(root, 'sentinel'), sentinel);
      }

      const result = await applyStagedFilesystemChanges({
        appliedAt: fixture.timestamp,
        before: fixture.before,
        changeSet: fixture.changeSet,
        persistResult: ignoreApplyResult,
        reviewId,
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity,
        targetRoot: fixture.targetRoot,
        targetRootIdentity,
        workspaceId: 'ws_demo',
      });

      expect({
        otherPath: readFileSync(join(otherPathRoot, 'sentinel'), 'utf8'),
        otherReview: readFileSync(join(otherReviewRoot, 'sentinel'), 'utf8'),
        ownedExists: existsSync(ownedRoot),
        userData: readFileSync(join(userRoot, 'sentinel'), 'utf8'),
      }).toEqual({
        otherPath: 'other path\n',
        otherReview: 'other review\n',
        ownedExists: false,
        userData: 'user data\n',
      });
      expect(result.status).toBe('applied');
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'missing',
    'corrupt',
  ] as const)('fails closed for an exact atomic replacement path with %s rollback proof', async (markerState) => {
    const fixture = await createChangedFileFixture(
      `replacement_collision_${markerState}`,
      'worker\n'
    );
    const reviewId = `swr_fs_replacement_collision_${markerState}`;
    const relativePath = 'notes.txt';
    const replacementRoot = replacementRootFor(fixture.targetRoot, reviewId, relativePath);
    const rollbackRoot = rollbackRootFor(fixture.stagingRoot, reviewId);
    const sentinelPath = join(replacementRoot, 'user-sentinel.txt');

    try {
      await mkdir(replacementRoot);
      await writeFile(sentinelPath, 'user data\n');
      if (markerState === 'corrupt') {
        await mkdir(rollbackRoot);
        await writeFile(join(rollbackRoot, 'ready.json'), '{not-json\n');
      }
      await expect(
        applyStagedFilesystemChanges({
          appliedAt: fixture.timestamp,
          before: fixture.before,
          changeSet: fixture.changeSet,
          persistResult: ignoreApplyResult,
          reviewId,
          stagingRoot: fixture.stagingRoot,
          stagingRootIdentity: await rootIdentity(fixture.stagingRoot),
          targetRoot: fixture.targetRoot,
          targetRootIdentity: await rootIdentity(fixture.targetRoot),
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow();

      expect({
        replacementRootExists: existsSync(replacementRoot),
        sentinel: existsSync(sentinelPath) ? readFileSync(sentinelPath, 'utf8') : null,
        targetContent: readFileSync(join(fixture.targetRoot, relativePath), 'utf8'),
      }).toEqual({
        replacementRootExists: true,
        sentinel: 'user data\n',
        targetContent: 'base\n',
      });
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it('fails closed when valid rollback proof omits the exact atomic replacement path', async () => {
    const fixture = await createChangedFileFixture('replacement_unproven_path', 'worker\n');
    const reviewId = 'swr_fs_replacement_unproven_path';
    const relativePath = 'notes.txt';
    const replacementRoot = replacementRootFor(fixture.targetRoot, reviewId, relativePath);
    const rollbackRoot = rollbackRootFor(fixture.stagingRoot, reviewId);
    const sentinelPath = join(replacementRoot, 'user-sentinel.txt');

    try {
      const { stagingRootIdentity, targetRootIdentity } = await createRollbackReadyFixture({
        changeSetId: fixture.changeSet.id,
        replacementPaths: ['other.txt'],
        reviewId,
        rollbackRoot,
        stagingRoot: fixture.stagingRoot,
        targetRoot: fixture.targetRoot,
        workspaceId: 'ws_demo',
      });
      await mkdir(join(rollbackRoot, 'files'), { recursive: true });
      await writeFile(join(rollbackRoot, 'files', relativePath), 'base\n');
      await mkdir(replacementRoot);
      await writeFile(sentinelPath, 'user data\n');

      await expect(
        applyStagedFilesystemChanges({
          appliedAt: fixture.timestamp,
          before: fixture.before,
          changeSet: fixture.changeSet,
          persistResult: ignoreApplyResult,
          reviewId,
          stagingRoot: fixture.stagingRoot,
          stagingRootIdentity,
          targetRoot: fixture.targetRoot,
          targetRootIdentity,
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow();
      expect({
        replacementRootExists: existsSync(replacementRoot),
        rollbackMarkerExists: existsSync(join(rollbackRoot, 'ready.json')),
        sentinel: readFileSync(sentinelPath, 'utf8'),
        targetContent: readFileSync(join(fixture.targetRoot, relativePath), 'utf8'),
      }).toEqual({
        replacementRootExists: true,
        rollbackMarkerExists: true,
        sentinel: 'user data\n',
        targetContent: 'base\n',
      });
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it('removes an apply-created added-file parent when replacement fails before file creation', async () => {
    const targetRoot = createRoot('openkit-fs-target-added-parent-rollback-');
    const workerRoot = createRoot('openkit-fs-worker-added-parent-rollback-');
    const stagingRoot = createRoot('openkit-fs-staging-added-parent-rollback-');
    const timestamp = '2026-06-27T12:09:10.000Z';
    const reviewId = 'swr_fs_added_parent_rollback';

    try {
      await mkdir(join(targetRoot, 'existing'));
      await chmod(join(targetRoot, 'existing'), 0o755);
      await mkdir(join(workerRoot, 'existing', 'nested'), { recursive: true });
      await chmod(join(workerRoot, 'existing'), 0o755);
      await chmod(join(workerRoot, 'existing', 'nested'), 0o755);
      await writeFile(join(workerRoot, 'existing', 'nested', 'file.txt'), 'new file\n');
      await chmod(join(workerRoot, 'existing', 'nested', 'file.txt'), 0o644);
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
        changeSetId: 'wcs_fs_added_parent_rollback',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_added_parent_rollback',
        materializationRecordId: 'wmr_fs_added_parent_rollback',
      });
      await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
      const [addedPath] = changeSet.changedPaths;
      if (!addedPath) {
        throw new Error('Expected one added filesystem path.');
      }
      const rollbackRoot = rollbackRootFor(stagingRoot, reviewId);
      let stagedFileMoved = false;
      const adversarialChangeSet = {
        ...changeSet,
        changedPaths: [
          {
            ...addedPath,
            /** Removes the staged source after rollback preparation but before replacement. */
            get status() {
              if (!stagedFileMoved && existsSync(rollbackRoot)) {
                renameSync(
                  join(stagingRoot, 'existing', 'nested', 'file.txt'),
                  join(stagingRoot, 'moved-file.txt')
                );
                stagedFileMoved = true;
              }
              return 'added' as const;
            },
          },
        ],
      } satisfies typeof changeSet;

      await expect(
        applyStagedFilesystemChanges({
          appliedAt: timestamp,
          before,
          changeSet: adversarialChangeSet,
          persistResult: ignoreApplyResult,
          reviewId,
          stagingRoot,
          stagingRootIdentity: await rootIdentity(stagingRoot),
          targetRoot,
          targetRootIdentity: await rootIdentity(targetRoot),
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow();
      expect({
        existingParent: existsSync(join(targetRoot, 'existing')),
        nestedParent: existsSync(join(targetRoot, 'existing', 'nested')),
        stagedFileMoved,
      }).toEqual({ existingParent: true, nestedParent: false, stagedFileMoved: true });
    } finally {
      await rm(targetRoot, { force: true, recursive: true });
      await rm(workerRoot, { force: true, recursive: true });
      await rm(stagingRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'outer-first',
    'inner-first',
  ] as const)('serializes filesystem applies whose canonical target roots overlap when %s', async (order) => {
    const orderName = order === 'outer-first' ? 'outer_first' : 'inner_first';
    const targetRoot = createRoot(`openkit-fs-target-concurrent-overlap-${orderName}-`);
    const innerTargetRoot = join(targetRoot, 'nested');
    const outerWorkerRoot = createRoot(`openkit-fs-worker-concurrent-overlap-${orderName}-outer-`);
    const outerStagingRoot = createRoot(
      `openkit-fs-staging-concurrent-overlap-${orderName}-outer-`
    );
    const innerWorkerRoot = createRoot(`openkit-fs-worker-concurrent-overlap-${orderName}-inner-`);
    const innerStagingRoot = createRoot(
      `openkit-fs-staging-concurrent-overlap-${orderName}-inner-`
    );
    const probe = await createChangedFileFixture(
      `concurrent_overlap_${orderName}_probe`,
      'probe review\n'
    );
    const timestamp = '2026-06-27T12:09:12.000Z';
    const firstPersistEntered = createPromiseGate();
    const releaseFirstPersist = createPromiseGate();
    let firstReleased = false;
    let secondPersistedBeforeRelease = false;

    try {
      await mkdir(innerTargetRoot, { recursive: true });
      await mkdir(join(outerWorkerRoot, 'nested'), { recursive: true });
      await writeFile(join(innerTargetRoot, 'notes.txt'), 'base\n');
      await writeFile(join(outerWorkerRoot, 'nested', 'notes.txt'), 'outer review\n');
      await writeFile(join(innerWorkerRoot, 'notes.txt'), 'inner review\n');
      for (const path of [
        join(innerTargetRoot, 'notes.txt'),
        join(outerWorkerRoot, 'nested', 'notes.txt'),
        join(innerWorkerRoot, 'notes.txt'),
      ]) {
        await chmod(path, 0o644);
      }
      const outerBefore = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_outer',
        rootPath: targetRoot,
        workspaceId: 'ws_demo',
      });
      const innerBefore = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_inner',
        rootPath: innerTargetRoot,
        workspaceId: 'ws_demo',
      });
      const outerAfter = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_outer',
        rootPath: outerWorkerRoot,
        workspaceId: 'ws_demo',
      });
      const innerAfter = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_inner',
        rootPath: innerWorkerRoot,
        workspaceId: 'ws_demo',
      });
      const outerChangeSet = buildFilesystemWorkspaceChangeSet({
        after: outerAfter,
        before: outerBefore,
        changeSetId: `wcs_fs_concurrent_overlap_${orderName}_outer`,
        createdAt: timestamp,
        inputSnapshotId: `wis_fs_concurrent_overlap_${orderName}_outer`,
        materializationRecordId: `wmr_fs_concurrent_overlap_${orderName}_outer`,
      });
      const innerChangeSet = buildFilesystemWorkspaceChangeSet({
        after: innerAfter,
        before: innerBefore,
        changeSetId: `wcs_fs_concurrent_overlap_${orderName}_inner`,
        createdAt: timestamp,
        inputSnapshotId: `wis_fs_concurrent_overlap_${orderName}_inner`,
        materializationRecordId: `wmr_fs_concurrent_overlap_${orderName}_inner`,
      });
      await stageFilesystemWorkspaceChanges({
        changeSet: outerChangeSet,
        sourceRoot: outerWorkerRoot,
        stagingRoot: outerStagingRoot,
      });
      await stageFilesystemWorkspaceChanges({
        changeSet: innerChangeSet,
        sourceRoot: innerWorkerRoot,
        stagingRoot: innerStagingRoot,
      });
      const outerInput = {
        before: outerBefore,
        changeSet: outerChangeSet,
        expectedContent: 'outer review\n',
        reviewId: `swr_fs_concurrent_overlap_${orderName}_outer`,
        stagingRoot: outerStagingRoot,
        targetRoot,
      };
      const innerInput = {
        before: innerBefore,
        changeSet: innerChangeSet,
        expectedContent: 'inner review\n',
        reviewId: `swr_fs_concurrent_overlap_${orderName}_inner`,
        stagingRoot: innerStagingRoot,
        targetRoot: innerTargetRoot,
      };
      const [firstInput, secondInput] =
        order === 'outer-first' ? [outerInput, innerInput] : [innerInput, outerInput];
      const firstApply = applyStagedFilesystemChanges({
        appliedAt: timestamp,
        before: firstInput.before,
        changeSet: firstInput.changeSet,
        persistResult: async () => {
          firstPersistEntered.open();
          await releaseFirstPersist.promise;
        },
        reviewId: firstInput.reviewId,
        stagingRoot: firstInput.stagingRoot,
        stagingRootIdentity: await rootIdentity(firstInput.stagingRoot),
        targetRoot: firstInput.targetRoot,
        targetRootIdentity: await rootIdentity(firstInput.targetRoot),
        workspaceId: 'ws_demo',
      });
      await firstPersistEntered.promise;
      const secondApply = applyStagedFilesystemChanges({
        appliedAt: timestamp,
        before: secondInput.before,
        changeSet: secondInput.changeSet,
        persistResult: () => {
          secondPersistedBeforeRelease ||= !firstReleased;
        },
        reviewId: secondInput.reviewId,
        stagingRoot: secondInput.stagingRoot,
        stagingRootIdentity: await rootIdentity(secondInput.stagingRoot),
        targetRoot: secondInput.targetRoot,
        targetRootIdentity: await rootIdentity(secondInput.targetRoot),
        workspaceId: 'ws_demo',
      });
      const probeResult = await applyStagedFilesystemChanges({
        appliedAt: probe.timestamp,
        before: probe.before,
        changeSet: probe.changeSet,
        persistResult: ignoreApplyResult,
        reviewId: `swr_fs_concurrent_overlap_${orderName}_probe`,
        stagingRoot: probe.stagingRoot,
        stagingRootIdentity: await rootIdentity(probe.stagingRoot),
        targetRoot: probe.targetRoot,
        targetRootIdentity: await rootIdentity(probe.targetRoot),
        workspaceId: 'ws_demo',
      });
      const secondPersistedBeforeFirstRelease = secondPersistedBeforeRelease;

      firstReleased = true;
      releaseFirstPersist.open();
      const [firstResult, secondResult] = await Promise.all([firstApply, secondApply]);

      expect(secondPersistedBeforeFirstRelease).toBe(false);
      expect([firstResult.status, secondResult.status, probeResult.status]).toEqual([
        'applied',
        'conflicted',
        'applied',
      ]);
      expect(readFileSync(join(innerTargetRoot, 'notes.txt'), 'utf8')).toBe(
        firstInput.expectedContent
      );
    } finally {
      firstReleased = true;
      releaseFirstPersist.open();
      await rm(targetRoot, { force: true, recursive: true });
      await rm(outerWorkerRoot, { force: true, recursive: true });
      await rm(outerStagingRoot, { force: true, recursive: true });
      await rm(innerWorkerRoot, { force: true, recursive: true });
      await rm(innerStagingRoot, { force: true, recursive: true });
      await rm(probe.targetRoot, { force: true, recursive: true });
      await rm(probe.workerRoot, { force: true, recursive: true });
      await rm(probe.stagingRoot, { force: true, recursive: true });
    }
  });

  it('does not let a later sibling bypass an earlier queued ancestor reservation', async () => {
    const targetContainer = createRoot('openkit-fs-target-concurrent-no-barging-');
    const sharedRoot = join(targetContainer, 'r');
    const targetARoot = join(sharedRoot, 'a');
    const targetCRoot = join(sharedRoot, 'b');
    const workerARoot = createRoot('openkit-fs-worker-concurrent-no-barging-a-');
    const workerBRoot = createRoot('openkit-fs-worker-concurrent-no-barging-b-');
    const workerCRoot = createRoot('openkit-fs-worker-concurrent-no-barging-c-');
    const stagingARoot = createRoot('openkit-fs-staging-concurrent-no-barging-a-');
    const stagingBRoot = createRoot('openkit-fs-staging-concurrent-no-barging-b-');
    const stagingCRoot = createRoot('openkit-fs-staging-concurrent-no-barging-c-');
    const probe = await createChangedFileFixture('concurrent_no_barging_probe', 'probe\n');
    const timestamp = '2026-06-27T12:09:13.000Z';
    const aPersistEntered = createPromiseGate();
    const releaseAPersist = createPromiseGate();
    const bPersistEntered = createPromiseGate();
    const releaseBPersist = createPromiseGate();
    const bReservationRegistered = createPromiseGate();
    const persistOrder: string[] = [];
    let bIdentityReadCount = 0;

    try {
      await mkdir(targetARoot, { recursive: true });
      await mkdir(targetCRoot, { recursive: true });
      await mkdir(join(workerBRoot, 'a'), { recursive: true });
      await mkdir(join(workerBRoot, 'b'), { recursive: true });
      await writeFile(join(targetARoot, 'notes.txt'), 'base a\n');
      await writeFile(join(targetCRoot, 'notes.txt'), 'base b\n');
      await writeFile(join(workerARoot, 'notes.txt'), 'review a\n');
      await writeFile(join(workerBRoot, 'a', 'notes.txt'), 'review b\n');
      await writeFile(join(workerBRoot, 'b', 'notes.txt'), 'base b\n');
      await writeFile(join(workerCRoot, 'notes.txt'), 'review c\n');
      for (const path of [
        join(targetARoot, 'notes.txt'),
        join(targetCRoot, 'notes.txt'),
        join(workerARoot, 'notes.txt'),
        join(workerBRoot, 'a', 'notes.txt'),
        join(workerBRoot, 'b', 'notes.txt'),
        join(workerCRoot, 'notes.txt'),
      ]) {
        await chmod(path, 0o644);
      }
      const beforeA = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_a',
        rootPath: targetARoot,
        workspaceId: 'ws_demo',
      });
      const beforeB = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_b',
        rootPath: sharedRoot,
        workspaceId: 'ws_demo',
      });
      const beforeC = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_c',
        rootPath: targetCRoot,
        workspaceId: 'ws_demo',
      });
      const afterA = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_a',
        rootPath: workerARoot,
        workspaceId: 'ws_demo',
      });
      const afterB = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_b',
        rootPath: workerBRoot,
        workspaceId: 'ws_demo',
      });
      const afterC = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_c',
        rootPath: workerCRoot,
        workspaceId: 'ws_demo',
      });
      const changeSetA = buildFilesystemWorkspaceChangeSet({
        after: afterA,
        before: beforeA,
        changeSetId: 'wcs_fs_concurrent_no_barging_a',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_concurrent_no_barging_a',
        materializationRecordId: 'wmr_fs_concurrent_no_barging_a',
      });
      const changeSetB = buildFilesystemWorkspaceChangeSet({
        after: afterB,
        before: beforeB,
        changeSetId: 'wcs_fs_concurrent_no_barging_b',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_concurrent_no_barging_b',
        materializationRecordId: 'wmr_fs_concurrent_no_barging_b',
      });
      const changeSetC = buildFilesystemWorkspaceChangeSet({
        after: afterC,
        before: beforeC,
        changeSetId: 'wcs_fs_concurrent_no_barging_c',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_concurrent_no_barging_c',
        materializationRecordId: 'wmr_fs_concurrent_no_barging_c',
      });
      await stageFilesystemWorkspaceChanges({
        changeSet: changeSetA,
        sourceRoot: workerARoot,
        stagingRoot: stagingARoot,
      });
      await stageFilesystemWorkspaceChanges({
        changeSet: changeSetB,
        sourceRoot: workerBRoot,
        stagingRoot: stagingBRoot,
      });
      await stageFilesystemWorkspaceChanges({
        changeSet: changeSetC,
        sourceRoot: workerCRoot,
        stagingRoot: stagingCRoot,
      });
      const sharedRootIdentity = await rootIdentity(sharedRoot);
      const applyA = applyStagedFilesystemChanges({
        appliedAt: timestamp,
        before: beforeA,
        changeSet: changeSetA,
        persistResult: async () => {
          persistOrder.push('A');
          aPersistEntered.open();
          await releaseAPersist.promise;
        },
        reviewId: 'swr_fs_concurrent_no_barging_a',
        stagingRoot: stagingARoot,
        stagingRootIdentity: await rootIdentity(stagingARoot),
        targetRoot: targetARoot,
        targetRootIdentity: await rootIdentity(targetARoot),
        workspaceId: 'ws_demo',
      });
      await aPersistEntered.promise;
      const applyB = applyStagedFilesystemChanges({
        appliedAt: timestamp,
        before: beforeB,
        changeSet: changeSetB,
        persistResult: async () => {
          persistOrder.push('B');
          bPersistEntered.open();
          await releaseBPersist.promise;
        },
        reviewId: 'swr_fs_concurrent_no_barging_b',
        stagingRoot: stagingBRoot,
        stagingRootIdentity: await rootIdentity(stagingBRoot),
        targetRoot: sharedRoot,
        get targetRootIdentity() {
          bIdentityReadCount += 1;
          if (bIdentityReadCount === 2) {
            bReservationRegistered.open();
          }
          return sharedRootIdentity;
        },
        workspaceId: 'ws_demo',
      });
      await bReservationRegistered.promise;
      const applyC = applyStagedFilesystemChanges({
        appliedAt: timestamp,
        before: beforeC,
        changeSet: changeSetC,
        persistResult: () => {
          persistOrder.push('C');
        },
        reviewId: 'swr_fs_concurrent_no_barging_c',
        stagingRoot: stagingCRoot,
        stagingRootIdentity: await rootIdentity(stagingCRoot),
        targetRoot: targetCRoot,
        targetRootIdentity: await rootIdentity(targetCRoot),
        workspaceId: 'ws_demo',
      });
      const probeResult = await applyStagedFilesystemChanges({
        appliedAt: probe.timestamp,
        before: probe.before,
        changeSet: probe.changeSet,
        persistResult: ignoreApplyResult,
        reviewId: 'swr_fs_concurrent_no_barging_probe',
        stagingRoot: probe.stagingRoot,
        stagingRootIdentity: await rootIdentity(probe.stagingRoot),
        targetRoot: probe.targetRoot,
        targetRootIdentity: await rootIdentity(probe.targetRoot),
        workspaceId: 'ws_demo',
      });
      const orderBeforeARelease = [...persistOrder];

      releaseAPersist.open();
      await bPersistEntered.promise;
      const orderBeforeBRelease = [...persistOrder];
      releaseBPersist.open();
      const [resultA, resultB, resultC] = await Promise.all([applyA, applyB, applyC]);

      expect(orderBeforeARelease).toEqual(['A']);
      expect(orderBeforeBRelease).toEqual(['A', 'B']);
      expect(persistOrder).toEqual(['A', 'B', 'C']);
      expect([resultA.status, resultB.status, resultC.status, probeResult.status]).toEqual([
        'applied',
        'conflicted',
        'applied',
        'applied',
      ]);
    } finally {
      releaseAPersist.open();
      releaseBPersist.open();
      await rm(targetContainer, { force: true, recursive: true });
      await rm(workerARoot, { force: true, recursive: true });
      await rm(workerBRoot, { force: true, recursive: true });
      await rm(workerCRoot, { force: true, recursive: true });
      await rm(stagingARoot, { force: true, recursive: true });
      await rm(stagingBRoot, { force: true, recursive: true });
      await rm(stagingCRoot, { force: true, recursive: true });
      await rm(probe.targetRoot, { force: true, recursive: true });
      await rm(probe.workerRoot, { force: true, recursive: true });
      await rm(probe.stagingRoot, { force: true, recursive: true });
    }
  });

  it('serializes filesystem applies that resolve to the same canonical target', async () => {
    const first = await createChangedFileFixture('concurrent_same_first', 'first review\n');
    const secondWorkerRoot = createRoot('openkit-fs-worker-concurrent-same-second-');
    const secondStagingRoot = createRoot('openkit-fs-staging-concurrent-same-second-');
    const targetAliasRoot = createRoot('openkit-fs-target-concurrent-same-alias-');
    const targetAlias = join(targetAliasRoot, 'target');
    const probe = await createChangedFileFixture('concurrent_same_probe', 'probe review\n');
    const firstPersistEntered = createPromiseGate();
    const releaseFirstPersist = createPromiseGate();
    let firstReleased = false;
    let secondPersistedBeforeRelease = false;

    try {
      await writeFile(join(secondWorkerRoot, 'notes.txt'), 'second review\n');
      await chmod(join(secondWorkerRoot, 'notes.txt'), 0o644);
      const secondAfter = await createFilesystemSnapshotManifest({
        createdAt: first.timestamp,
        resourceId: 'fs_default',
        rootPath: secondWorkerRoot,
        workspaceId: 'ws_demo',
      });
      const secondChangeSet = buildFilesystemWorkspaceChangeSet({
        after: secondAfter,
        before: first.before,
        changeSetId: 'wcs_fs_concurrent_same_second',
        createdAt: first.timestamp,
        inputSnapshotId: 'wis_fs_concurrent_same_second',
        materializationRecordId: 'wmr_fs_concurrent_same_second',
      });
      await stageFilesystemWorkspaceChanges({
        changeSet: secondChangeSet,
        sourceRoot: secondWorkerRoot,
        stagingRoot: secondStagingRoot,
      });
      await symlink(first.targetRoot, targetAlias, 'dir');
      const targetIdentity = await rootIdentity(first.targetRoot);
      const firstApply = applyStagedFilesystemChanges({
        appliedAt: first.timestamp,
        before: first.before,
        changeSet: first.changeSet,
        persistResult: async () => {
          firstPersistEntered.open();
          await releaseFirstPersist.promise;
        },
        reviewId: 'swr_fs_concurrent_same_first',
        stagingRoot: first.stagingRoot,
        stagingRootIdentity: await rootIdentity(first.stagingRoot),
        targetRoot: first.targetRoot,
        targetRootIdentity: targetIdentity,
        workspaceId: 'ws_demo',
      });
      await firstPersistEntered.promise;
      const secondApply = applyStagedFilesystemChanges({
        appliedAt: first.timestamp,
        before: first.before,
        changeSet: secondChangeSet,
        persistResult: () => {
          secondPersistedBeforeRelease ||= !firstReleased;
        },
        reviewId: 'swr_fs_concurrent_same_second',
        stagingRoot: secondStagingRoot,
        stagingRootIdentity: await rootIdentity(secondStagingRoot),
        targetRoot: targetAlias,
        targetRootIdentity: targetIdentity,
        workspaceId: 'ws_demo',
      });
      const probeResult = await applyStagedFilesystemChanges({
        appliedAt: probe.timestamp,
        before: probe.before,
        changeSet: probe.changeSet,
        persistResult: ignoreApplyResult,
        reviewId: 'swr_fs_concurrent_same_probe',
        stagingRoot: probe.stagingRoot,
        stagingRootIdentity: await rootIdentity(probe.stagingRoot),
        targetRoot: probe.targetRoot,
        targetRootIdentity: await rootIdentity(probe.targetRoot),
        workspaceId: 'ws_demo',
      });
      const beforeRelease = {
        secondPersistedBeforeRelease,
        targetContent: readFileSync(join(first.targetRoot, 'notes.txt'), 'utf8'),
      };

      firstReleased = true;
      releaseFirstPersist.open();
      const [firstResult, secondResult] = await Promise.all([firstApply, secondApply]);

      expect(beforeRelease).toEqual({
        secondPersistedBeforeRelease: false,
        targetContent: 'first review\n',
      });
      expect([firstResult.status, secondResult.status, probeResult.status]).toEqual([
        'applied',
        'conflicted',
        'applied',
      ]);
    } finally {
      firstReleased = true;
      releaseFirstPersist.open();
      await rm(first.targetRoot, { force: true, recursive: true });
      await rm(first.workerRoot, { force: true, recursive: true });
      await rm(first.stagingRoot, { force: true, recursive: true });
      await rm(secondWorkerRoot, { force: true, recursive: true });
      await rm(secondStagingRoot, { force: true, recursive: true });
      await rm(targetAliasRoot, { force: true, recursive: true });
      await rm(probe.targetRoot, { force: true, recursive: true });
      await rm(probe.workerRoot, { force: true, recursive: true });
      await rm(probe.stagingRoot, { force: true, recursive: true });
    }
  });

  it('releases a queued target apply after its lock predecessor throws', async () => {
    const fixture = await createChangedFileFixture('concurrent_error_release', 'worker\n');
    const probe = await createChangedFileFixture('concurrent_error_release_probe', 'probe\n');
    const firstPersistEntered = createPromiseGate();
    const releaseFirstPersist = createPromiseGate();
    let firstReleased = false;
    let secondPersistedBeforeRelease = false;

    try {
      const firstApply = applyStagedFilesystemChanges({
        appliedAt: fixture.timestamp,
        before: fixture.before,
        changeSet: fixture.changeSet,
        persistResult: async () => {
          firstPersistEntered.open();
          await releaseFirstPersist.promise;
          throw new Error('first durable persistence failed');
        },
        reviewId: 'swr_fs_concurrent_error_release_first',
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity: await rootIdentity(fixture.stagingRoot),
        targetRoot: fixture.targetRoot,
        targetRootIdentity: await rootIdentity(fixture.targetRoot),
        workspaceId: 'ws_demo',
      });
      const firstOutcome = firstApply.then(
        () => null,
        (error: unknown) => error
      );
      await firstPersistEntered.promise;
      const secondApply = applyStagedFilesystemChanges({
        appliedAt: fixture.timestamp,
        before: fixture.before,
        changeSet: fixture.changeSet,
        persistResult: () => {
          secondPersistedBeforeRelease ||= !firstReleased;
        },
        reviewId: 'swr_fs_concurrent_error_release_second',
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity: await rootIdentity(fixture.stagingRoot),
        targetRoot: fixture.targetRoot,
        targetRootIdentity: await rootIdentity(fixture.targetRoot),
        workspaceId: 'ws_demo',
      });
      const probeResult = await applyStagedFilesystemChanges({
        appliedAt: probe.timestamp,
        before: probe.before,
        changeSet: probe.changeSet,
        persistResult: ignoreApplyResult,
        reviewId: 'swr_fs_concurrent_error_release_probe',
        stagingRoot: probe.stagingRoot,
        stagingRootIdentity: await rootIdentity(probe.stagingRoot),
        targetRoot: probe.targetRoot,
        targetRootIdentity: await rootIdentity(probe.targetRoot),
        workspaceId: 'ws_demo',
      });
      const beforeRelease = {
        secondPersistedBeforeRelease,
        targetContent: readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8'),
      };

      firstReleased = true;
      releaseFirstPersist.open();
      const [firstError, secondResult] = await Promise.all([firstOutcome, secondApply]);

      expect(beforeRelease).toEqual({
        secondPersistedBeforeRelease: false,
        targetContent: 'worker\n',
      });
      expect(firstError).toEqual(new Error('first durable persistence failed'));
      expect([secondResult.status, probeResult.status]).toEqual(['applied', 'applied']);
      expect(readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8')).toBe('worker\n');
    } finally {
      firstReleased = true;
      releaseFirstPersist.open();
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
      await rm(probe.targetRoot, { force: true, recursive: true });
      await rm(probe.workerRoot, { force: true, recursive: true });
      await rm(probe.stagingRoot, { force: true, recursive: true });
    }
  });

  it('allows filesystem applies for different canonical targets to persist in parallel', async () => {
    const first = await createChangedFileFixture('concurrent_different_first', 'first target\n');
    const second = await createChangedFileFixture('concurrent_different_second', 'second target\n');
    const firstPersistEntered = createPromiseGate();
    const releaseFirstPersist = createPromiseGate();
    const secondPersistEntered = createPromiseGate();
    let firstReleased = false;

    try {
      const firstApply = applyStagedFilesystemChanges({
        appliedAt: first.timestamp,
        before: first.before,
        changeSet: first.changeSet,
        persistResult: async () => {
          firstPersistEntered.open();
          await releaseFirstPersist.promise;
        },
        reviewId: 'swr_fs_concurrent_different_first',
        stagingRoot: first.stagingRoot,
        stagingRootIdentity: await rootIdentity(first.stagingRoot),
        targetRoot: first.targetRoot,
        targetRootIdentity: await rootIdentity(first.targetRoot),
        workspaceId: 'ws_demo',
      });
      await firstPersistEntered.promise;
      const secondApply = applyStagedFilesystemChanges({
        appliedAt: second.timestamp,
        before: second.before,
        changeSet: second.changeSet,
        persistResult: () => {
          secondPersistEntered.open();
        },
        reviewId: 'swr_fs_concurrent_different_second',
        stagingRoot: second.stagingRoot,
        stagingRootIdentity: await rootIdentity(second.stagingRoot),
        targetRoot: second.targetRoot,
        targetRootIdentity: await rootIdentity(second.targetRoot),
        workspaceId: 'ws_demo',
      });

      await secondPersistEntered.promise;
      const beforeRelease = {
        firstReleased,
        secondContent: readFileSync(join(second.targetRoot, 'notes.txt'), 'utf8'),
      };
      firstReleased = true;
      releaseFirstPersist.open();
      const [firstResult, secondResult] = await Promise.all([firstApply, secondApply]);

      expect(beforeRelease).toEqual({ firstReleased: false, secondContent: 'second target\n' });
      expect([firstResult.status, secondResult.status]).toEqual(['applied', 'applied']);
    } finally {
      firstReleased = true;
      releaseFirstPersist.open();
      await rm(first.targetRoot, { force: true, recursive: true });
      await rm(first.workerRoot, { force: true, recursive: true });
      await rm(first.stagingRoot, { force: true, recursive: true });
      await rm(second.targetRoot, { force: true, recursive: true });
      await rm(second.workerRoot, { force: true, recursive: true });
      await rm(second.stagingRoot, { force: true, recursive: true });
    }
  });

  it('creates reviewed parent directories with exact permissions under a restrictive umask', async () => {
    const targetRoot = createRoot('openkit-fs-target-directory-mode-');
    const workerRoot = createRoot('openkit-fs-worker-directory-mode-');
    const stagingRoot = createRoot('openkit-fs-staging-directory-mode-');
    const timestamp = '2026-06-27T12:09:15.000Z';

    try {
      await mkdir(join(workerRoot, 'new', 'nested'), { recursive: true });
      await chmod(join(workerRoot, 'new'), 0o755);
      await chmod(join(workerRoot, 'new', 'nested'), 0o755);
      await writeFile(join(workerRoot, 'new', 'nested', 'file.txt'), 'new file\n');
      await chmod(join(workerRoot, 'new', 'nested', 'file.txt'), 0o644);
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
        changeSetId: 'wcs_fs_directory_mode',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_directory_mode',
        materializationRecordId: 'wmr_fs_directory_mode',
      });
      await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
      const stagingRootIdentity = await rootIdentity(stagingRoot);
      const targetRootIdentity = await rootIdentity(targetRoot);
      const previousUmask = process.umask(0o077);

      try {
        await applyStagedFilesystemChanges({
          appliedAt: timestamp,
          before,
          changeSet,
          persistResult: ignoreApplyResult,
          reviewId: 'swr_fs_directory_mode',
          stagingRoot,
          stagingRootIdentity,
          targetRoot,
          targetRootIdentity,
          workspaceId: 'ws_demo',
        });
      } finally {
        process.umask(previousUmask);
      }

      expect((await stat(join(targetRoot, 'new'))).mode & 0o777).toBe(0o755);
      expect((await stat(join(targetRoot, 'new', 'nested'))).mode & 0o777).toBe(0o755);
    } finally {
      await rm(targetRoot, { force: true, recursive: true });
      await rm(workerRoot, { force: true, recursive: true });
      await rm(stagingRoot, { force: true, recursive: true });
    }
  });

  it('does not follow a parent symlink swapped in after target validation', async () => {
    const targetRoot = createRoot('openkit-fs-target-parent-swap-');
    const workerRoot = createRoot('openkit-fs-worker-parent-swap-');
    const stagingRoot = createRoot('openkit-fs-staging-parent-swap-');
    const outsideRoot = createRoot('openkit-fs-outside-parent-swap-');
    const timestamp = '2026-06-27T12:09:20.000Z';
    const reviewId = 'swr_fs_parent_swap';
    const rollbackRoot = rollbackRootFor(stagingRoot, reviewId);
    const outsideFile = join(outsideRoot, 'notes.txt');

    try {
      await mkdir(join(targetRoot, 'docs'));
      await mkdir(join(workerRoot, 'docs'));
      await writeFile(join(targetRoot, 'docs', 'notes.txt'), 'base\n');
      await writeFile(outsideFile, 'outside\n');
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
        changeSetId: 'wcs_fs_parent_swap',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_parent_swap',
        materializationRecordId: 'wmr_fs_parent_swap',
      });
      const [deletedPath] = changeSet.changedPaths;
      if (!deletedPath) {
        throw new Error('Expected one deleted filesystem path.');
      }
      let parentWasSwapped = false;
      const adversarialChangeSet = {
        ...changeSet,
        changedPaths: [
          {
            ...deletedPath,
            /** Swaps the validated parent immediately before the delete status branch executes. */
            get status() {
              if (!parentWasSwapped && existsSync(rollbackRoot)) {
                renameSync(join(targetRoot, 'docs'), join(targetRoot, 'docs-original'));
                symlinkSync(outsideRoot, join(targetRoot, 'docs'), 'dir');
                parentWasSwapped = true;
              }
              return 'deleted' as const;
            },
          },
        ],
      } satisfies typeof changeSet;

      let applyError: unknown = null;
      try {
        await applyStagedFilesystemChanges({
          appliedAt: timestamp,
          before,
          changeSet: adversarialChangeSet,
          persistResult: ignoreApplyResult,
          reviewId,
          stagingRoot,
          stagingRootIdentity: await rootIdentity(stagingRoot),
          targetRoot,
          targetRootIdentity: await rootIdentity(targetRoot),
          workspaceId: 'ws_demo',
        });
      } catch (error) {
        applyError = error;
      }

      expect(parentWasSwapped).toBe(true);
      expect(existsSync(outsideFile)).toBe(true);
      expect(applyError).toBeInstanceOf(Error);
    } finally {
      await rm(targetRoot, { force: true, recursive: true });
      await rm(workerRoot, { force: true, recursive: true });
      await rm(stagingRoot, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'empty-directory-added',
    'directory-removed',
    'directory-mode-changed',
    'symlink-changed',
  ] as const)('fails closed for unsupported non-file change: %s', async (scenario) => {
    const targetRoot = createRoot(`openkit-fs-target-${scenario}-`);
    const workerRoot = createRoot(`openkit-fs-worker-${scenario}-`);
    const outsideRoot = createRoot(`openkit-fs-outside-${scenario}-`);
    const timestamp = '2026-06-27T12:09:30.000Z';

    try {
      if (scenario === 'empty-directory-added') {
        await mkdir(join(workerRoot, 'empty'));
      } else if (scenario === 'directory-removed') {
        await mkdir(join(targetRoot, 'empty'));
      } else if (scenario === 'directory-mode-changed') {
        await mkdir(join(targetRoot, 'folder'));
        await mkdir(join(workerRoot, 'folder'));
        await chmod(join(targetRoot, 'folder'), 0o755);
        await chmod(join(workerRoot, 'folder'), 0o700);
      } else {
        await writeFile(join(outsideRoot, 'outside.txt'), 'outside\n');
        await symlink(join(outsideRoot, 'outside.txt'), join(targetRoot, 'link.txt'));
      }

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

      expect(() =>
        buildFilesystemWorkspaceChangeSet({
          after,
          before,
          changeSetId: `wcs_fs_${scenario}`,
          createdAt: timestamp,
          inputSnapshotId: `wis_fs_${scenario}`,
          materializationRecordId: `wmr_fs_${scenario}`,
        })
      ).toThrow(/unsupported/i);
    } finally {
      await rm(targetRoot, { force: true, recursive: true });
      await rm(workerRoot, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
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

  it('rejects filesystem staging through a root-internal symlink parent before creating descendants', async () => {
    const workerRoot = createRoot('openkit-fs-worker-internal-symlink-');
    const stagingRoot = createRoot('openkit-fs-staging-internal-symlink-');
    const timestamp = '2026-06-27T12:11:00.000Z';

    try {
      await mkdir(join(workerRoot, 'alias', 'nested'), { recursive: true });
      await writeFile(join(workerRoot, 'alias', 'nested', 'escape.txt'), 'must not traverse\n');
      await mkdir(join(stagingRoot, 'real'));
      await symlink(join(stagingRoot, 'real'), join(stagingRoot, 'alias'), 'dir');

      await expect(
        stageFilesystemWorkspaceChanges({
          changeSet: {
            artifactIds: [],
            base: { commit: null, contentDigest: 'sha256:before' },
            bundle: null,
            changedPaths: [{ path: 'alias/nested/escape.txt', status: 'added' }],
            createdAt: timestamp,
            evidenceRefs: [],
            head: { commit: null, contentDigest: 'sha256:after' },
            id: 'wcs_fs_internal_symlink',
            inputSnapshotId: 'wis_fs_internal_symlink',
            materializationRecordId: 'wmr_fs_internal_symlink',
            patch: null,
            redaction: { notes: [], status: 'no-sensitive-content-found' },
            resourceId: 'fs_default',
            strategy: 'filesystem',
            workspaceId: 'ws_demo',
          },
          sourceRoot: workerRoot,
          stagingRoot,
        })
      ).rejects.toThrow();
      expect(existsSync(join(stagingRoot, 'real', 'nested'))).toBe(false);
    } finally {
      await rm(workerRoot, { force: true, recursive: true });
      await rm(stagingRoot, { force: true, recursive: true });
    }
  });

  it('rejects filesystem apply through a root-internal symlink parent before creating descendants', async () => {
    const targetRoot = createRoot('openkit-fs-target-apply-internal-symlink-');
    const workerRoot = createRoot('openkit-fs-worker-apply-internal-symlink-');
    const stagingRoot = createRoot('openkit-fs-staging-apply-internal-symlink-');
    const timestamp = '2026-06-27T12:12:00.000Z';

    try {
      await mkdir(join(workerRoot, 'alias', 'nested'), { recursive: true });
      await writeFile(join(workerRoot, 'alias', 'nested', 'new.txt'), 'must not traverse\n');

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
        changeSetId: 'wcs_fs_apply_internal_symlink',
        createdAt: timestamp,
        inputSnapshotId: 'wis_fs_apply_internal_symlink',
        materializationRecordId: 'wmr_fs_apply_internal_symlink',
      });
      await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
      await mkdir(join(targetRoot, 'real'));
      await symlink(join(targetRoot, 'real'), join(targetRoot, 'alias'), 'dir');

      const result = await applyStagedFilesystemChanges({
        appliedAt: timestamp,
        before,
        changeSet,
        persistResult: ignoreApplyResult,
        reviewId: 'swr_fs_apply_internal_symlink',
        stagingRoot,
        stagingRootIdentity: await rootIdentity(stagingRoot),
        targetRoot,
        targetRootIdentity: await rootIdentity(targetRoot),
        workspaceId: 'ws_demo',
      });

      expect(result).toMatchObject({
        appliedPaths: [],
        conflictRecords: [expect.stringContaining('alias')],
        status: 'conflicted',
      });
      expect(existsSync(join(targetRoot, 'real', 'nested'))).toBe(false);
    } finally {
      await rm(targetRoot, { force: true, recursive: true });
      await rm(workerRoot, { force: true, recursive: true });
      await rm(stagingRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ['modified', 'worker\n'],
    ['deleted', null],
  ] as const)('reports a conflict when a %s target has been chmodded since its snapshot', async (status, workerContent) => {
    const fixture = await createChangedFileFixture(`permission_${status}`, workerContent);

    try {
      expect(fixture.changeSet.changedPaths).toMatchObject([{ status }]);
      await chmod(join(fixture.targetRoot, 'notes.txt'), 0o600);

      const result = await applyStagedFilesystemChanges({
        appliedAt: fixture.timestamp,
        before: fixture.before,
        changeSet: fixture.changeSet,
        persistResult: ignoreApplyResult,
        reviewId: `swr_fs_permission_${status}`,
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity: await rootIdentity(fixture.stagingRoot),
        targetRoot: fixture.targetRoot,
        targetRootIdentity: await rootIdentity(fixture.targetRoot),
        workspaceId: 'ws_demo',
      });

      expect(result).toMatchObject({
        appliedPaths: [],
        conflictRecords: ['Target permissions changed since snapshot: notes.txt'],
        status: 'conflicted',
      });
      expect(readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8')).toBe('base\n');
      expect((await stat(join(fixture.targetRoot, 'notes.txt'))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it('rejects a staged file whose reviewed content changed before apply', async () => {
    const fixture = await createChangedFileFixture('staging_drift', 'worker\n');

    try {
      await writeFile(join(fixture.stagingRoot, 'notes.txt'), 'tampered\n');

      const result = await applyStagedFilesystemChanges({
        appliedAt: fixture.timestamp,
        before: fixture.before,
        changeSet: fixture.changeSet,
        persistResult: ignoreApplyResult,
        reviewId: 'swr_fs_staging_drift',
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity: await rootIdentity(fixture.stagingRoot),
        targetRoot: fixture.targetRoot,
        targetRootIdentity: await rootIdentity(fixture.targetRoot),
        workspaceId: 'ws_demo',
      });

      expect(result).toMatchObject({ appliedPaths: [], status: 'conflicted' });
      expect(readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8')).toBe('base\n');
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it('removes only the same review deterministic rollback preparation orphan on retry', async () => {
    const fixture = await createChangedFileFixture('rollback_preparation_orphan', 'worker\n');
    const reviewId = 'swr_fs_rollback_preparation_orphan';
    const preparationRoot = rollbackPreparationRootFor(fixture.stagingRoot, reviewId);
    const preparationOwnerPath = `${preparationRoot}.owner.json`;
    const otherReviewRoot = rollbackPreparationRootFor(fixture.stagingRoot, `${reviewId}_other`);
    const userCollisionRoot = `${preparationRoot}-user-data`;

    try {
      const stagingRootIdentity = await rootIdentity(fixture.stagingRoot);
      const targetRootIdentity = await rootIdentity(fixture.targetRoot);
      const targetRealPath = await realpath(fixture.targetRoot);
      await mkdir(join(preparationRoot, 'files'), { recursive: true });
      await writeFile(join(preparationRoot, 'files', 'notes.txt'), 'partial backup\n');
      await writeFile(
        preparationOwnerPath,
        `${JSON.stringify({
          changeSetId: fixture.changeSet.id,
          reviewId,
          stagingRootIdentity,
          targetRootDigest: `sha256:${createHash('sha256')
            .update(Buffer.from(targetRealPath))
            .digest('hex')}`,
          targetRootIdentity,
          version: 1,
          workspaceId: 'ws_demo',
        })}\n`
      );
      await mkdir(otherReviewRoot);
      await writeFile(join(otherReviewRoot, 'sentinel.txt'), 'other review\n');
      await mkdir(userCollisionRoot);
      await writeFile(join(userCollisionRoot, 'sentinel.txt'), 'user collision\n');

      const result = await applyStagedFilesystemChanges({
        appliedAt: fixture.timestamp,
        before: fixture.before,
        changeSet: fixture.changeSet,
        persistResult: ignoreApplyResult,
        reviewId,
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity,
        targetRoot: fixture.targetRoot,
        targetRootIdentity,
        workspaceId: 'ws_demo',
      });

      expect({
        otherReview: readFileSync(join(otherReviewRoot, 'sentinel.txt'), 'utf8'),
        ownedPreparationExists: existsSync(preparationRoot),
        ownedPreparationOwnerExists: existsSync(preparationOwnerPath),
        status: result.status,
        userCollision: readFileSync(join(userCollisionRoot, 'sentinel.txt'), 'utf8'),
      }).toEqual({
        otherReview: 'other review\n',
        ownedPreparationExists: false,
        ownedPreparationOwnerExists: false,
        status: 'applied',
        userCollision: 'user collision\n',
      });
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'missing',
    'corrupt',
    'mismatch',
  ] as const)('fails closed and preserves a deterministic rollback preparation with %s owner proof', async (ownerState) => {
    const fixture = await createChangedFileFixture(
      `rollback_preparation_owner_${ownerState}`,
      'worker\n'
    );
    const reviewId = `swr_fs_rollback_preparation_owner_${ownerState}`;
    const preparationRoot = rollbackPreparationRootFor(fixture.stagingRoot, reviewId);
    const preparationOwnerPath = `${preparationRoot}.owner.json`;
    const sentinelPath = join(preparationRoot, 'sentinel.txt');

    try {
      const stagingRootIdentity = await rootIdentity(fixture.stagingRoot);
      const targetRootIdentity = await rootIdentity(fixture.targetRoot);
      const targetRealPath = await realpath(fixture.targetRoot);
      await mkdir(preparationRoot);
      await writeFile(sentinelPath, 'partial rollback data\n');
      if (ownerState === 'corrupt') {
        await writeFile(preparationOwnerPath, '{not-json\n');
      } else if (ownerState === 'mismatch') {
        await writeFile(
          preparationOwnerPath,
          `${JSON.stringify({
            changeSetId: fixture.changeSet.id,
            reviewId: `${reviewId}_other`,
            stagingRootIdentity,
            targetRootDigest: `sha256:${createHash('sha256')
              .update(Buffer.from(targetRealPath))
              .digest('hex')}`,
            targetRootIdentity,
            version: 1,
            workspaceId: 'ws_demo',
          })}\n`
        );
      }

      await expect(
        applyStagedFilesystemChanges({
          appliedAt: fixture.timestamp,
          before: fixture.before,
          changeSet: fixture.changeSet,
          persistResult: ignoreApplyResult,
          reviewId,
          stagingRoot: fixture.stagingRoot,
          stagingRootIdentity,
          targetRoot: fixture.targetRoot,
          targetRootIdentity,
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow();
      expect({
        ownerExists: existsSync(preparationOwnerPath),
        preparationExists: existsSync(preparationRoot),
        sentinel: readFileSync(sentinelPath, 'utf8'),
        targetContent: readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8'),
      }).toEqual({
        ownerExists: ownerState !== 'missing',
        preparationExists: true,
        sentinel: 'partial rollback data\n',
        targetContent: 'base\n',
      });
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it('refuses crash recovery when a target was human-edited after rollback preparation', async () => {
    const fixture = await createChangedFileFixture('recovery_human_edit', 'worker\n');
    const reviewId = 'swr_fs_recovery_human_edit';
    const rollbackRoot = rollbackRootFor(fixture.stagingRoot, reviewId);
    const backupPath = join(rollbackRoot, 'files', 'notes.txt');

    try {
      const { stagingRootIdentity, targetRootIdentity } = await createRollbackReadyFixture({
        changeSetId: fixture.changeSet.id,
        replacementPaths: fixture.changeSet.changedPaths.map((entry) => entry.path),
        reviewId,
        rollbackRoot,
        stagingRoot: fixture.stagingRoot,
        targetRoot: fixture.targetRoot,
        workspaceId: 'ws_demo',
      });
      await mkdir(join(rollbackRoot, 'files'), { recursive: true });
      await writeFile(backupPath, 'base\n');
      await writeFile(join(fixture.targetRoot, 'notes.txt'), 'worker\n');
      await writeFile(join(fixture.targetRoot, 'notes.txt'), 'human edit\n');

      await expect(
        applyStagedFilesystemChanges({
          appliedAt: fixture.timestamp,
          before: fixture.before,
          changeSet: fixture.changeSet,
          persistResult: ignoreApplyResult,
          reviewId,
          stagingRoot: fixture.stagingRoot,
          stagingRootIdentity,
          targetRoot: fixture.targetRoot,
          targetRootIdentity,
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow();
      expect(readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8')).toBe('human edit\n');
      expect(readFileSync(backupPath, 'utf8')).toBe('base\n');
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it('does not let mutable staging content authorize rollback over a human edit', async () => {
    const fixture = await createChangedFileFixture('recovery_staging_drift', 'worker\n');
    const reviewId = 'swr_fs_recovery_staging_drift';
    const rollbackRoot = rollbackRootFor(fixture.stagingRoot, reviewId);
    const backupPath = join(rollbackRoot, 'files', 'notes.txt');

    try {
      const { stagingRootIdentity, targetRootIdentity } = await createRollbackReadyFixture({
        changeSetId: fixture.changeSet.id,
        replacementPaths: fixture.changeSet.changedPaths.map((entry) => entry.path),
        reviewId,
        rollbackRoot,
        stagingRoot: fixture.stagingRoot,
        targetRoot: fixture.targetRoot,
        workspaceId: 'ws_demo',
      });
      await mkdir(join(rollbackRoot, 'files'), { recursive: true });
      await writeFile(backupPath, 'base\n');
      await writeFile(join(fixture.targetRoot, 'notes.txt'), 'human edit\n');
      await writeFile(join(fixture.stagingRoot, 'notes.txt'), 'human edit\n');

      await expect(
        applyStagedFilesystemChanges({
          appliedAt: fixture.timestamp,
          before: fixture.before,
          changeSet: fixture.changeSet,
          persistResult: ignoreApplyResult,
          reviewId,
          stagingRoot: fixture.stagingRoot,
          stagingRootIdentity,
          targetRoot: fixture.targetRoot,
          targetRootIdentity,
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow();
      expect(readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8')).toBe('human edit\n');
      expect(readFileSync(backupPath, 'utf8')).toBe('base\n');
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it('serializes committed rollback cleanup with an in-flight apply on the same target', async () => {
    const fixture = await createChangedFileFixture('cleanup_concurrent_apply', 'worker\n');
    const probe = await createChangedFileFixture('cleanup_concurrent_apply_probe', 'probe\n');
    const reviewId = 'swr_fs_cleanup_concurrent_apply';
    const rollbackRoot = rollbackRootFor(fixture.stagingRoot, reviewId);
    const applyPersistEntered = createPromiseGate();
    const releaseApplyPersist = createPromiseGate();
    let applyReleased = false;
    let cleanupCompletedBeforeRelease = false;

    try {
      const stagingRootIdentity = await rootIdentity(fixture.stagingRoot);
      const targetRootIdentity = await rootIdentity(fixture.targetRoot);
      const apply = applyStagedFilesystemChanges({
        appliedAt: fixture.timestamp,
        before: fixture.before,
        changeSet: fixture.changeSet,
        persistResult: async () => {
          applyPersistEntered.open();
          await releaseApplyPersist.promise;
        },
        reviewId,
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity,
        targetRoot: fixture.targetRoot,
        targetRootIdentity,
        workspaceId: 'ws_demo',
      });
      await applyPersistEntered.promise;
      const cleanup = cleanupCommittedFilesystemRollback({
        changeSetId: fixture.changeSet.id,
        reviewId,
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity,
        targetRoot: fixture.targetRoot,
        targetRootIdentity,
        workspaceId: 'ws_demo',
      }).then(() => {
        cleanupCompletedBeforeRelease ||= !applyReleased;
      });
      const probeResult = await applyStagedFilesystemChanges({
        appliedAt: probe.timestamp,
        before: probe.before,
        changeSet: probe.changeSet,
        persistResult: ignoreApplyResult,
        reviewId: 'swr_fs_cleanup_concurrent_apply_probe',
        stagingRoot: probe.stagingRoot,
        stagingRootIdentity: await rootIdentity(probe.stagingRoot),
        targetRoot: probe.targetRoot,
        targetRootIdentity: await rootIdentity(probe.targetRoot),
        workspaceId: 'ws_demo',
      });
      const beforeRelease = {
        cleanupCompletedBeforeRelease,
        rollbackRootExists: existsSync(rollbackRoot),
        targetContent: readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8'),
      };

      applyReleased = true;
      releaseApplyPersist.open();
      const [applyResult] = await Promise.all([apply, cleanup]);

      expect(beforeRelease).toEqual({
        cleanupCompletedBeforeRelease: false,
        rollbackRootExists: true,
        targetContent: 'worker\n',
      });
      expect([applyResult.status, probeResult.status]).toEqual(['applied', 'applied']);
      expect(existsSync(rollbackRoot)).toBe(false);
      await expect(
        cleanupCommittedFilesystemRollback({
          changeSetId: fixture.changeSet.id,
          reviewId,
          stagingRoot: fixture.stagingRoot,
          stagingRootIdentity,
          targetRoot: fixture.targetRoot,
          targetRootIdentity,
          workspaceId: 'ws_demo',
        })
      ).resolves.toBeUndefined();
    } finally {
      applyReleased = true;
      releaseApplyPersist.open();
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
      await rm(probe.targetRoot, { force: true, recursive: true });
      await rm(probe.workerRoot, { force: true, recursive: true });
      await rm(probe.stagingRoot, { force: true, recursive: true });
    }
  });

  it('does not clean rollback data owned by another workspace with colliding local ids', async () => {
    const stagingRoot = createRoot('openkit-fs-staging-cleanup-workspace-lineage-');
    const targetRoot = createRoot('openkit-fs-target-cleanup-workspace-lineage-');
    const reviewId = 'swr_fs_cleanup_workspace_lineage';
    const changeSetId = 'wcs_fs_cleanup_workspace_lineage';
    const rollbackRoot = rollbackRootFor(stagingRoot, reviewId, 'ws_owner');
    const backupPath = join(rollbackRoot, 'files', 'notes.txt');

    try {
      const { stagingRootIdentity, targetRootIdentity } = await createRollbackReadyFixture({
        changeSetId,
        replacementPaths: [],
        reviewId,
        rollbackRoot,
        stagingRoot,
        targetRoot,
        workspaceId: 'ws_owner',
      });
      await mkdir(join(rollbackRoot, 'files'), { recursive: true });
      await writeFile(backupPath, 'base\n');
      const cleanupInput = {
        changeSetId,
        reviewId,
        stagingRoot,
        stagingRootIdentity,
        targetRoot,
        targetRootIdentity,
        workspaceId: 'ws_other',
      };

      await expect(cleanupCommittedFilesystemRollback(cleanupInput)).resolves.toBeUndefined();
      expect(readFileSync(backupPath, 'utf8')).toBe('base\n');
    } finally {
      await rm(stagingRoot, { force: true, recursive: true });
      await rm(targetRoot, { force: true, recursive: true });
    }
  });

  it.each([
    { field: 'changeSetId', markerPatch: { changeSetId: 'wcs_fs_cleanup_other' } },
    { field: 'stagingRootIdentity', markerPatch: { stagingRootIdentity: '1:1' } },
    { field: 'targetRootDigest', markerPatch: { targetRootDigest: 'sha256:other' } },
    { field: 'targetRootIdentity', markerPatch: { targetRootIdentity: '2:2' } },
  ])('preserves committed rollback data when marker $field mismatches', async ({ markerPatch }) => {
    const stagingRoot = createRoot('openkit-fs-staging-cleanup-lineage-');
    const targetRoot = createRoot('openkit-fs-target-cleanup-lineage-');
    const reviewId = 'swr_fs_cleanup_lineage';
    const changeSetId = 'wcs_fs_cleanup_lineage';
    const rollbackRoot = rollbackRootFor(stagingRoot, reviewId);
    const backupPath = join(rollbackRoot, 'files', 'notes.txt');

    try {
      const { stagingRootIdentity, targetRootIdentity } = await createRollbackReadyFixture({
        changeSetId,
        markerPatch,
        replacementPaths: [],
        reviewId,
        rollbackRoot,
        stagingRoot,
        targetRoot,
        workspaceId: 'ws_demo',
      });
      await mkdir(join(rollbackRoot, 'files'), { recursive: true });
      await writeFile(backupPath, 'base\n');
      const cleanupInput = {
        changeSetId,
        reviewId,
        stagingRoot,
        stagingRootIdentity,
        targetRoot,
        targetRootIdentity,
        workspaceId: 'ws_demo',
      };

      await expect(cleanupCommittedFilesystemRollback(cleanupInput)).rejects.toThrow(
        /lineage mismatch/i
      );
      expect(readFileSync(backupPath, 'utf8')).toBe('base\n');
    } finally {
      await rm(stagingRoot, { force: true, recursive: true });
      await rm(targetRoot, { force: true, recursive: true });
    }
  });

  it('removes an empty rollback root left by completed cleanup before retrying apply', async () => {
    const fixture = await createChangedFileFixture('recovery_empty_cleanup_residue', 'worker\n');
    const reviewId = 'swr_fs_recovery_empty_cleanup_residue';
    const rollbackRoot = rollbackRootFor(fixture.stagingRoot, reviewId);

    try {
      await mkdir(rollbackRoot);

      const result = await applyStagedFilesystemChanges({
        appliedAt: fixture.timestamp,
        before: fixture.before,
        changeSet: fixture.changeSet,
        persistResult: ignoreApplyResult,
        reviewId,
        stagingRoot: fixture.stagingRoot,
        stagingRootIdentity: await rootIdentity(fixture.stagingRoot),
        targetRoot: fixture.targetRoot,
        targetRootIdentity: await rootIdentity(fixture.targetRoot),
        workspaceId: 'ws_demo',
      });

      expect({
        rollbackRootExists: existsSync(rollbackRoot),
        status: result.status,
        targetContent: readFileSync(join(fixture.targetRoot, 'notes.txt'), 'utf8'),
      }).toEqual({
        rollbackRootExists: false,
        status: 'applied',
        targetContent: 'worker\n',
      });
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'missing',
    'corrupt',
  ] as const)('fails closed and preserves rollback backups when the ready marker is %s', async (markerState) => {
    const fixture = await createChangedFileFixture(`recovery_${markerState}`, 'worker\n');
    const reviewId = `swr_fs_recovery_${markerState}`;
    const rollbackRoot = rollbackRootFor(fixture.stagingRoot, reviewId);
    const backupPath = join(rollbackRoot, 'files', 'notes.txt');

    try {
      await mkdir(join(rollbackRoot, 'files'), { recursive: true });
      await writeFile(backupPath, 'base\n');
      if (markerState === 'corrupt') {
        await writeFile(join(rollbackRoot, 'ready.json'), '{not-json\n');
      }
      await writeFile(join(fixture.targetRoot, 'notes.txt'), 'worker\n');

      await expect(
        applyStagedFilesystemChanges({
          appliedAt: fixture.timestamp,
          before: fixture.before,
          changeSet: fixture.changeSet,
          persistResult: ignoreApplyResult,
          reviewId,
          stagingRoot: fixture.stagingRoot,
          stagingRootIdentity: await rootIdentity(fixture.stagingRoot),
          targetRoot: fixture.targetRoot,
          targetRootIdentity: await rootIdentity(fixture.targetRoot),
          workspaceId: 'ws_demo',
        })
      ).rejects.toThrow();
      expect(readFileSync(backupPath, 'utf8')).toBe('base\n');
    } finally {
      await rm(fixture.targetRoot, { force: true, recursive: true });
      await rm(fixture.workerRoot, { force: true, recursive: true });
      await rm(fixture.stagingRoot, { force: true, recursive: true });
    }
  });
});
