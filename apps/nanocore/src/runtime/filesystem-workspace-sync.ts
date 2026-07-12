import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import {
  type WorkspaceApplyResult,
  WorkspaceApplyResultSchema,
  type WorkspaceChangeSet,
  WorkspaceChangeSetSchema,
} from '@openkit/app-api-schemas';

const defaultIgnoredPathPrefixes = ['.git', 'node_modules'];
const unsafeRelativePathPattern = /(^|\/)\.\.(\/|$)/;
/** Process-local target reservations, including queued overlapping operations. */
const filesystemTargetReservations: Array<{
  readonly identity: string;
  readonly rootPath: string;
  readonly settled: Promise<void>;
}> = [];

/** File entry kind tracked by filesystem snapshot manifests. */
export type FilesystemSnapshotEntryKind = 'file' | 'directory' | 'symlink' | 'ignored';

/** One content-addressed filesystem snapshot entry. */
export interface FilesystemSnapshotEntry {
  /** Workspace-relative path. */
  readonly path: string;
  /** Entry kind. */
  readonly kind: FilesystemSnapshotEntryKind;
  /** File size when this entry is a file. */
  readonly size: number | null;
  /** SHA-256 digest when this entry is a file. */
  readonly digest: string | null;
  /** POSIX permission summary such as `0644`. */
  readonly permissions: string | null;
  /** Whether this path belongs to a writable scope. */
  readonly writable: boolean;
  /** Ignore reason when this entry is intentionally excluded. */
  readonly ignoreReason: string | null;
}

/** Content-addressed filesystem snapshot manifest. */
export interface FilesystemSnapshotManifest {
  /** Workspace id that owns the snapshot. */
  readonly workspaceId: string;
  /** Filesystem resource id. */
  readonly resourceId: string;
  /** Content digest over product-safe manifest entries. */
  readonly contentDigest: string;
  /** Manifest creation timestamp. */
  readonly createdAt: string;
  /** Product-safe entries sorted by path. */
  readonly entries: readonly FilesystemSnapshotEntry[];
}

/** Input for creating a filesystem snapshot manifest. */
export interface CreateFilesystemSnapshotManifestInput {
  /** Workspace id that owns the snapshot. */
  readonly workspaceId: string;
  /** Filesystem resource id. */
  readonly resourceId: string;
  /** Host-local root path to scan. */
  readonly rootPath: string;
  /** Manifest creation timestamp. */
  readonly createdAt: string;
  /** Optional ignored workspace-relative path prefixes. */
  readonly ignoredPathPrefixes?: readonly string[] | undefined;
}

/** Input for building one filesystem workspace change set. */
export interface BuildFilesystemWorkspaceChangeSetInput {
  /** Snapshot captured before worker execution. */
  readonly before: FilesystemSnapshotManifest;
  /** Snapshot captured after worker execution. */
  readonly after: FilesystemSnapshotManifest;
  /** Stable change set id. */
  readonly changeSetId: string;
  /** Materialization record id that produced the change set. */
  readonly materializationRecordId: string;
  /** Input snapshot id used for materialization. */
  readonly inputSnapshotId: string;
  /** Change set creation timestamp. */
  readonly createdAt: string;
}

/** Input for staging changed filesystem files. */
export interface StageFilesystemWorkspaceChangesInput {
  /** Filesystem change set to stage. */
  readonly changeSet: WorkspaceChangeSet;
  /** Worker output root containing changed files. */
  readonly sourceRoot: string;
  /** Host staging root that receives changed files. */
  readonly stagingRoot: string;
}

/** Result of staging filesystem workspace changes. */
export interface StageFilesystemWorkspaceChangesResult {
  /** Workspace-relative paths copied into the staging root. */
  readonly stagedPaths: readonly string[];
}

/** Input for applying staged filesystem changes to a target workspace. */
export interface ApplyStagedFilesystemChangesInput {
  /** Workspace id that owns the apply action. */
  readonly workspaceId: string;
  /** Staged review id being accepted. */
  readonly reviewId: string;
  /** Filesystem change set being applied. */
  readonly changeSet: WorkspaceChangeSet;
  /** Snapshot captured before worker execution. */
  readonly before: FilesystemSnapshotManifest;
  /** Staging root containing added or modified files. */
  readonly stagingRoot: string;
  /** Device and inode identity captured when the staging root was registered. */
  readonly stagingRootIdentity: string;
  /** Target workspace root to mutate after conflict checks pass. */
  readonly targetRoot: string;
  /** Device and inode identity captured when the target root was registered. */
  readonly targetRootIdentity: string;
  /** Apply timestamp. */
  readonly appliedAt: string;
  /** Durable finalizer that must succeed before rollback data is removed. */
  readonly persistResult: (result: WorkspaceApplyResult) => Promise<void> | void;
}

/** Durable rollback ownership marker published before target mutation. */
interface FilesystemRollbackMarker {
  /** Change set whose writes are recoverable. */
  readonly changeSetId: string;
  /** Exact normalized paths whose deterministic replacement roots are owned. */
  readonly replacementPaths: readonly string[];
  /** Review that owns the rollback state. */
  readonly reviewId: string;
  /** Registered staging root identity. */
  readonly stagingRootIdentity: string;
  /** Digest of the canonical target root path. */
  readonly targetRootDigest: string;
  /** Registered target root identity. */
  readonly targetRootIdentity: string;
  /** Marker format version. */
  readonly version: 1;
  /** Workspace that owns the review-local ids. */
  readonly workspaceId: string;
}

/**
 * Creates a content-addressed filesystem snapshot manifest.
 *
 * @param input Snapshot root and product lineage.
 * @returns Product-safe filesystem snapshot manifest.
 */
export async function createFilesystemSnapshotManifest(
  input: CreateFilesystemSnapshotManifestInput
): Promise<FilesystemSnapshotManifest> {
  const ignoredPathPrefixes = [
    ...defaultIgnoredPathPrefixes,
    ...(input.ignoredPathPrefixes ?? []),
  ].map(normalizeRelativePath);
  const entries: FilesystemSnapshotEntry[] = [];

  await collectEntries(input.rootPath, '', ignoredPathPrefixes, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));

  return {
    contentDigest: digestJson(entries),
    createdAt: input.createdAt,
    entries,
    resourceId: input.resourceId,
    workspaceId: input.workspaceId,
  };
}

/**
 * Builds a filesystem workspace change set by comparing two manifests.
 *
 * @param input Before and after manifests plus lineage ids.
 * @returns Workspace change set using the `filesystem` strategy.
 */
export function buildFilesystemWorkspaceChangeSet(
  input: BuildFilesystemWorkspaceChangeSetInput
): WorkspaceChangeSet {
  assertSupportedNonFileChanges(input.before, input.after);
  const beforeFiles = fileEntriesByPath(input.before);
  const afterFiles = fileEntriesByPath(input.after);
  const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort();
  const changedPaths: WorkspaceChangeSet['changedPaths'] = [];

  for (const path of paths) {
    const before = beforeFiles.get(path);
    const after = afterFiles.get(path);

    if (!before && after) {
      changedPaths.push({
        binary: false,
        digest: after.digest ?? undefined,
        newPermissions: after.permissions ?? undefined,
        path,
        size: after.size ?? 0,
        status: 'added',
      });
      continue;
    }

    if (before && !after) {
      changedPaths.push({
        binary: false,
        digest: before.digest ?? undefined,
        oldPermissions: before.permissions ?? undefined,
        path,
        size: before.size ?? 0,
        status: 'deleted',
      });
      continue;
    }

    if (before && after && before.digest !== after.digest) {
      changedPaths.push({
        binary: false,
        digest: after.digest ?? undefined,
        newPermissions: after.permissions ?? undefined,
        oldPermissions: before.permissions ?? undefined,
        path,
        size: after.size ?? 0,
        status: 'modified',
      });
      continue;
    }

    if (before && after && before.permissions !== after.permissions) {
      changedPaths.push({
        binary: false,
        digest: after.digest ?? undefined,
        newPermissions: after.permissions ?? undefined,
        oldPermissions: before.permissions ?? undefined,
        path,
        size: after.size ?? 0,
        status: 'mode_changed',
      });
    }
  }

  return WorkspaceChangeSetSchema.parse({
    artifactIds: [],
    base: { commit: null, contentDigest: input.before.contentDigest },
    bundle: null,
    changedPaths,
    createdAt: input.createdAt,
    evidenceRefs: [],
    head: { commit: null, contentDigest: input.after.contentDigest },
    id: input.changeSetId,
    inputSnapshotId: input.inputSnapshotId,
    materializationRecordId: input.materializationRecordId,
    patch: null,
    redaction: { notes: [], status: 'no-sensitive-content-found' },
    resourceId: input.before.resourceId,
    strategy: 'filesystem',
    workspaceId: input.before.workspaceId,
  });
}

/**
 * Rejects non-file changes that the file-oriented apply contract cannot reproduce exactly.
 *
 * Non-empty standard-permission parent directories may be created implicitly for added files.
 * Empty directories, directory removal or mode changes, and symlink changes fail closed.
 *
 * @param before Snapshot captured before worker execution.
 * @param after Snapshot captured after worker execution.
 */
function assertSupportedNonFileChanges(
  before: FilesystemSnapshotManifest,
  after: FilesystemSnapshotManifest
): void {
  const relevantEntries = (manifest: FilesystemSnapshotManifest) =>
    manifest.entries.filter(
      (entry) => entry.kind === 'directory' || entry.ignoreReason === 'symlink'
    );
  const beforeEntries = new Map(relevantEntries(before).map((entry) => [entry.path, entry]));
  const afterEntries = new Map(relevantEntries(after).map((entry) => [entry.path, entry]));
  const afterFiles = after.entries.filter((entry) => entry.kind === 'file');

  for (const path of new Set([...beforeEntries.keys(), ...afterEntries.keys()])) {
    const beforeEntry = beforeEntries.get(path);
    const afterEntry = afterEntries.get(path);
    if (JSON.stringify(beforeEntry) === JSON.stringify(afterEntry)) {
      continue;
    }
    if (
      !beforeEntry &&
      afterEntry?.kind === 'directory' &&
      afterEntry.permissions === '0755' &&
      afterFiles.some((entry) => entry.path.startsWith(`${path}/`))
    ) {
      continue;
    }
    throw new Error(`Unsupported non-file filesystem change: ${path}`);
  }
}

/**
 * Copies added and modified files into a staging root for human review.
 *
 * @param input Change set and filesystem roots.
 * @returns Staged path summary.
 */
export async function stageFilesystemWorkspaceChanges(
  input: StageFilesystemWorkspaceChangesInput
): Promise<StageFilesystemWorkspaceChangesResult> {
  const stagedPaths: string[] = [];
  const sourceRoot = await realpath(input.sourceRoot);
  const stagingRoot = await realpath(input.stagingRoot);

  for (const changedPath of input.changeSet.changedPaths) {
    assertSafeRelativePath(changedPath.path);

    if (changedPath.status === 'deleted') {
      continue;
    }

    const parentConflict = await detectWritableParentConflict(stagingRoot, changedPath.path);
    if (parentConflict) {
      throw new Error(`unsafe filesystem path: ${changedPath.path}`);
    }
    const sourcePath = await requireExistingPathWithinRoot(sourceRoot, changedPath.path);
    const sourceState = await readFilesystemFileState(sourceRoot, changedPath.path);
    if (!sourceState || !changedFileMatchesDeclaration(changedPath, sourceState)) {
      throw new Error(`Filesystem source does not match reviewed change: ${changedPath.path}`);
    }
    const targetPath = await prepareWritablePathWithinRoot(stagingRoot, changedPath.path);
    const replacement = filesystemReplacementRoot(
      stagingRoot,
      input.changeSet.workspaceId,
      input.changeSet.id,
      changedPath.path
    );

    await removeFilesystemReplacementRoot(replacement);
    await replaceFileFromSource(sourcePath, targetPath, changedPath.newPermissions, replacement);
    const stagedState = await readFilesystemFileState(stagingRoot, changedPath.path);
    if (!stagedState || !changedFileMatchesDeclaration(changedPath, stagedState)) {
      throw new Error(`Filesystem staging does not match reviewed change: ${changedPath.path}`);
    }
    stagedPaths.push(changedPath.path);
  }

  return { stagedPaths };
}

/**
 * Reserves a canonical target and queues behind all earlier overlapping reservations.
 *
 * @param rootPath Canonical target root path.
 * @param identity Registered target directory identity.
 * @returns Idempotent release callback.
 */
async function reserveFilesystemTarget(rootPath: string, identity: string): Promise<() => void> {
  const blockers = filesystemTargetReservations
    .filter(
      (reservation) =>
        reservation.identity === identity ||
        pathWithinRoot(reservation.rootPath, rootPath) ||
        pathWithinRoot(rootPath, reservation.rootPath)
    )
    .map((reservation) => reservation.settled);
  let settle = (): void => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const reservation = { identity, rootPath, settled };
  filesystemTargetReservations.push(reservation);
  await Promise.all(blockers);

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    settle();
    const index = filesystemTargetReservations.indexOf(reservation);
    if (index >= 0) {
      filesystemTargetReservations.splice(index, 1);
    }
  };
}

/**
 * Applies staged filesystem changes to a target root after conflict preflight.
 *
 * @param input Staged filesystem apply input.
 * @returns Durable workspace apply result.
 */
export async function applyStagedFilesystemChanges(
  input: ApplyStagedFilesystemChangesInput
): Promise<WorkspaceApplyResult> {
  const stagingRoot = await realpath(input.stagingRoot);
  const targetRoot = await realpath(input.targetRoot);
  await requireFilesystemRootIdentity(stagingRoot, input.stagingRootIdentity);
  await requireFilesystemRootIdentity(targetRoot, input.targetRootIdentity);
  const release = await reserveFilesystemTarget(targetRoot, input.targetRootIdentity);

  try {
    await requireFilesystemRootIdentity(stagingRoot, input.stagingRootIdentity);
    await requireFilesystemRootIdentity(targetRoot, input.targetRootIdentity);
    const rollbackDirectoryName = filesystemRollbackDirectoryName(
      input.workspaceId,
      input.reviewId
    );
    const rollbackRoot = join(stagingRoot, rollbackDirectoryName);
    const reservedPaths = [
      rollbackDirectoryName,
      `${rollbackDirectoryName}.prepare`,
      `${rollbackDirectoryName}.prepare.owner.json`,
    ];

    for (const changedPath of input.changeSet.changedPaths) {
      assertSafeRelativePath(changedPath.path);
      const normalizedPath = normalizeRelativePath(changedPath.path);
      if (
        reservedPaths.some(
          (path) => normalizedPath === path || normalizedPath.startsWith(`${path}/`)
        )
      ) {
        throw new Error(`Reserved filesystem workspace path: ${changedPath.path}`);
      }
    }

    const replacementPaths = filesystemReplacementPaths(input.changeSet);
    await cleanupFilesystemRollbackPreparation(input, stagingRoot, targetRoot, rollbackRoot);
    await recoverFilesystemRollback(input, stagingRoot, targetRoot, rollbackRoot, replacementPaths);
    const conflicts = await detectConflicts(input);

    if (conflicts.length > 0) {
      const result = WorkspaceApplyResultSchema.parse({
        appliedAt: input.appliedAt,
        appliedPaths: [],
        changeSetId: input.changeSet.id,
        commitIds: [],
        conflictRecords: conflicts,
        id: `war_${input.reviewId}`,
        reviewId: input.reviewId,
        skippedPaths: input.changeSet.changedPaths.map((entry) => entry.path),
        status: 'conflicted',
        verification: [{ command: 'filesystem conflict preflight', ref: null, status: 'failed' }],
        workspaceId: input.workspaceId,
      });
      await input.persistResult(result);
      return result;
    }

    await prepareFilesystemRollback(input, stagingRoot, targetRoot, rollbackRoot, replacementPaths);
    const rollback = await readFilesystemRollbackMarker(rollbackRoot, stagingRoot, targetRoot, {
      changeSetId: input.changeSet.id,
      replacementPaths,
      reviewId: input.reviewId,
      stagingRootIdentity: input.stagingRootIdentity,
      targetRootIdentity: input.targetRootIdentity,
      workspaceId: input.workspaceId,
    });
    if (!rollback) {
      throw new Error(`Filesystem rollback marker was not published: ${input.reviewId}`);
    }
    // ponytail: filesystem apply assumes one external writer; add an openat-style native boundary only if that assumption changes.
    const changedPaths = input.changeSet.changedPaths.map((changedPath) => ({ ...changedPath }));
    let result: WorkspaceApplyResult;

    try {
      for (const changedPath of changedPaths) {
        await requireTargetMatchesBefore(input.before, targetRoot, changedPath);
        assertSafeRelativePath(changedPath.path);

        const targetPath = await prepareWritablePathWithinRoot(targetRoot, changedPath.path);

        if (changedPath.status === 'deleted') {
          await rm(targetPath, { force: true });
          continue;
        }

        if (changedPath.status === 'mode_changed') {
          await chmod(targetPath, parsePermissionsSummary(changedPath.newPermissions ?? ''));
          continue;
        }

        const stagedPath = await requireExistingPathWithinRoot(stagingRoot, changedPath.path);

        await replaceFileFromSource(
          stagedPath,
          targetPath,
          changedPath.newPermissions,
          filesystemReplacementRoot(targetRoot, input.workspaceId, input.reviewId, changedPath.path)
        );
      }

      result = WorkspaceApplyResultSchema.parse({
        appliedAt: input.appliedAt,
        appliedPaths: changedPaths.map((entry) => entry.path),
        changeSetId: input.changeSet.id,
        commitIds: [],
        conflictRecords: [],
        id: `war_${input.reviewId}`,
        reviewId: input.reviewId,
        skippedPaths: [],
        status: 'applied',
        verification: [{ command: 'filesystem conflict preflight', ref: null, status: 'passed' }],
        workspaceId: input.workspaceId,
      });
      await input.persistResult(result);
    } catch (error) {
      try {
        await cleanupFilesystemReplacementRoots(
          targetRoot,
          input.workspaceId,
          input.reviewId,
          rollback.marker.replacementPaths
        );
        await restoreFilesystemRollback(
          input,
          targetRoot,
          rollback.rootPath,
          rollback.marker.replacementPaths
        );
        await cleanupFilesystemRollback(rollback, targetRoot, input.workspaceId, input.reviewId);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Filesystem workspace apply and rollback failed: ${
            rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'
          }`
        );
      }
      throw error;
    }

    await cleanupFilesystemRollback(rollback, targetRoot, input.workspaceId, input.reviewId);
    return result;
  } finally {
    release();
  }
}

/**
 * Removes recovery data left after an accepted filesystem result was durably committed.
 *
 * @param input Review lineage and trusted staging and target roots.
 */
export async function cleanupCommittedFilesystemRollback(input: {
  readonly changeSetId: string;
  readonly reviewId: string;
  readonly stagingRoot: string;
  readonly stagingRootIdentity: string;
  readonly targetRoot: string;
  readonly targetRootIdentity: string;
  readonly workspaceId: string;
}): Promise<void> {
  const stagingRoot = await realpath(input.stagingRoot);
  await requireFilesystemRootIdentity(stagingRoot, input.stagingRootIdentity);
  const targetRoot = await realpath(input.targetRoot);
  await requireFilesystemRootIdentity(targetRoot, input.targetRootIdentity);
  const release = await reserveFilesystemTarget(targetRoot, input.targetRootIdentity);

  try {
    await requireFilesystemRootIdentity(stagingRoot, input.stagingRootIdentity);
    await requireFilesystemRootIdentity(targetRoot, input.targetRootIdentity);
    const rollbackRoot = join(
      stagingRoot,
      filesystemRollbackDirectoryName(input.workspaceId, input.reviewId)
    );
    const rollback = await readFilesystemRollbackMarker(rollbackRoot, stagingRoot, targetRoot, {
      changeSetId: input.changeSetId,
      reviewId: input.reviewId,
      stagingRootIdentity: input.stagingRootIdentity,
      targetRootIdentity: input.targetRootIdentity,
      workspaceId: input.workspaceId,
    });
    if (!rollback) {
      return;
    }

    await cleanupFilesystemRollback(rollback, targetRoot, input.workspaceId, input.reviewId);
  } finally {
    release();
  }
}

/**
 * Reads path metadata and treats an absent path as null.
 *
 * @param path Host path to inspect.
 * @returns Path metadata, or null when absent.
 */
async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return null;
    }
    throw error;
  }
}

/**
 * Lists exact normalized paths that use deterministic atomic replacement roots.
 *
 * @param changeSet Reviewed filesystem change set.
 * @returns Replacement-backed paths in change-set order.
 */
function filesystemReplacementPaths(changeSet: WorkspaceChangeSet): string[] {
  const paths: string[] = [];
  for (const changedPath of changeSet.changedPaths) {
    if (changedPath.status === 'mode_changed') {
      continue;
    }
    assertSafeRelativePath(changedPath.path);
    const normalizedPath = normalizeRelativePath(changedPath.path);
    if (paths.includes(normalizedPath)) {
      throw new Error(`Duplicate filesystem replacement path: ${normalizedPath}`);
    }
    paths.push(normalizedPath);
  }
  return paths;
}

/**
 * Reads and validates one atomically published rollback marker.
 *
 * @param rollbackRoot Expected rollback root.
 * @param stagingRoot Canonical staging root.
 * @param targetRoot Canonical target root.
 * @param expected Expected rollback lineage and optional exact replacement paths.
 * @returns Validated marker and canonical rollback root, or null when absent.
 */
async function readFilesystemRollbackMarker(
  rollbackRoot: string,
  stagingRoot: string,
  targetRoot: string,
  expected: {
    readonly changeSetId: string;
    readonly replacementPaths?: readonly string[] | undefined;
    readonly reviewId: string;
    readonly stagingRootIdentity: string;
    readonly targetRootIdentity: string;
    readonly workspaceId: string;
  }
): Promise<{ readonly marker: FilesystemRollbackMarker; readonly rootPath: string } | null> {
  const rollbackStats = await lstatIfExists(rollbackRoot);
  if (!rollbackStats) {
    return null;
  }
  if (!rollbackStats.isDirectory() || rollbackStats.isSymbolicLink()) {
    throw new Error(`Unsafe filesystem rollback root: ${expected.reviewId}`);
  }
  const rollbackRealPath = await realpath(rollbackRoot);
  assertPathWithinRoot(stagingRoot, rollbackRealPath);
  if ((await readdir(rollbackRealPath)).length === 0) {
    try {
      await rmdir(rollbackRealPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return null;
  }

  let marker: unknown;
  try {
    const markerPath = join(rollbackRealPath, 'ready.json');
    const markerStats = await lstat(markerPath);
    if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
      throw new Error('Filesystem rollback marker is not a regular file.');
    }
    marker = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Filesystem rollback marker is unreadable: ${expected.reviewId}`, {
      cause: error,
    });
  }

  if (
    !marker ||
    typeof marker !== 'object' ||
    Object.keys(marker).length !== 8 ||
    !('changeSetId' in marker) ||
    marker.changeSetId !== expected.changeSetId ||
    !('replacementPaths' in marker) ||
    !Array.isArray(marker.replacementPaths) ||
    !('reviewId' in marker) ||
    marker.reviewId !== expected.reviewId ||
    !('stagingRootIdentity' in marker) ||
    marker.stagingRootIdentity !== expected.stagingRootIdentity ||
    !('targetRootDigest' in marker) ||
    marker.targetRootDigest !== digestBuffer(Buffer.from(targetRoot)) ||
    !('targetRootIdentity' in marker) ||
    marker.targetRootIdentity !== expected.targetRootIdentity ||
    !('version' in marker) ||
    marker.version !== 1 ||
    !('workspaceId' in marker) ||
    marker.workspaceId !== expected.workspaceId
  ) {
    throw new Error(`Filesystem rollback lineage mismatch: ${expected.reviewId}`);
  }

  const replacementPaths: string[] = [];
  try {
    for (const path of marker.replacementPaths) {
      if (typeof path !== 'string') {
        throw new Error('Filesystem replacement path is not a string.');
      }
      assertSafeRelativePath(path);
      if (path !== normalizeRelativePath(path) || replacementPaths.includes(path)) {
        throw new Error('Filesystem replacement path is not exact.');
      }
      replacementPaths.push(path);
    }
  } catch (error) {
    throw new Error(`Filesystem rollback lineage mismatch: ${expected.reviewId}`, {
      cause: error,
    });
  }
  if (
    expected.replacementPaths &&
    (expected.replacementPaths.length !== replacementPaths.length ||
      expected.replacementPaths.some((path, index) => path !== replacementPaths[index]))
  ) {
    throw new Error(`Filesystem rollback replacement lineage mismatch: ${expected.reviewId}`);
  }

  return {
    marker: {
      changeSetId: expected.changeSetId,
      replacementPaths,
      reviewId: expected.reviewId,
      stagingRootIdentity: expected.stagingRootIdentity,
      targetRootDigest: digestBuffer(Buffer.from(targetRoot)),
      targetRootIdentity: expected.targetRootIdentity,
      version: 1,
      workspaceId: expected.workspaceId,
    },
    rootPath: rollbackRealPath,
  };
}

/**
 * Removes validated rollback content while keeping ready.json until every other cleanup succeeds.
 *
 * @param rollback Previously validated rollback marker and root.
 * @param targetRoot Canonical target root.
 * @param workspaceId Workspace that owns the review.
 * @param reviewId Review that owns the rollback.
 */
async function cleanupFilesystemRollback(
  rollback: { readonly marker: FilesystemRollbackMarker; readonly rootPath: string },
  targetRoot: string,
  workspaceId: string,
  reviewId: string
): Promise<void> {
  await cleanupFilesystemReplacementRoots(
    targetRoot,
    workspaceId,
    reviewId,
    rollback.marker.replacementPaths
  );

  const rootStats = await lstatIfExists(rollback.rootPath);
  if (!rootStats) {
    return;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Unsafe filesystem rollback root: ${reviewId}`);
  }
  const rootEntries = await readdir(rollback.rootPath, { withFileTypes: true });
  if (rootEntries.length === 0) {
    try {
      await rmdir(rollback.rootPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return;
  }

  const readyEntry = rootEntries.find((entry) => entry.name === 'ready.json');
  const filesEntry = rootEntries.find((entry) => entry.name === 'files');
  if (
    !readyEntry?.isFile() ||
    readyEntry.isSymbolicLink() ||
    (filesEntry && (!filesEntry.isDirectory() || filesEntry.isSymbolicLink())) ||
    rootEntries.some((entry) => entry.name !== 'ready.json' && entry.name !== 'files')
  ) {
    throw new Error(`Filesystem rollback root contains unknown content: ${reviewId}`);
  }

  const backupFiles: string[] = [];
  const backupDirectories: string[] = [];
  if (filesEntry) {
    const filesRoot = join(rollback.rootPath, 'files');
    const filesRealPath = await realpath(filesRoot);
    assertPathWithinRoot(rollback.rootPath, filesRealPath);
    const directoriesToVisit = [''];
    for (let index = 0; index < directoriesToVisit.length; index += 1) {
      const relativeDirectory = directoriesToVisit[index] ?? '';
      const directoryPath = relativeDirectory
        ? join(filesRealPath, relativeDirectory)
        : filesRealPath;
      const entries = await readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          directoriesToVisit.push(relativePath);
          backupDirectories.push(relativePath);
          continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(`Filesystem rollback root contains unknown content: ${reviewId}`);
        }
        backupFiles.push(relativePath);
      }
    }
  }

  const filesRoot = join(rollback.rootPath, 'files');
  for (const relativePath of backupFiles) {
    await rm(join(filesRoot, relativePath), { force: true });
  }
  backupDirectories.sort((left, right) => right.split('/').length - left.split('/').length);
  for (const relativePath of backupDirectories) {
    try {
      await rmdir(join(filesRoot, relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  if (filesEntry) {
    try {
      await rmdir(filesRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  await rm(join(rollback.rootPath, 'ready.json'), { force: true });
  try {
    await rmdir(rollback.rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Cleans one deterministic rollback preparation only when its sibling owner proves lineage.
 *
 * @param input Filesystem apply input.
 * @param stagingRoot Canonical staging root.
 * @param targetRoot Canonical target root.
 * @param rollbackRoot Review-specific rollback root.
 */
async function cleanupFilesystemRollbackPreparation(
  input: ApplyStagedFilesystemChangesInput,
  stagingRoot: string,
  targetRoot: string,
  rollbackRoot: string
): Promise<void> {
  const preparationRoot = `${rollbackRoot}.prepare`;
  const ownerPath = `${preparationRoot}.owner.json`;
  const [preparationStats, ownerStats] = await Promise.all([
    lstatIfExists(preparationRoot),
    lstatIfExists(ownerPath),
  ]);
  if (!preparationStats && !ownerStats) {
    return;
  }
  if (!ownerStats?.isFile() || ownerStats.isSymbolicLink()) {
    throw new Error(`Filesystem rollback preparation owner is unreadable: ${input.reviewId}`);
  }

  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(ownerPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Filesystem rollback preparation owner is unreadable: ${input.reviewId}`, {
      cause: error,
    });
  }
  if (
    !owner ||
    typeof owner !== 'object' ||
    Object.keys(owner).length !== 7 ||
    !('changeSetId' in owner) ||
    owner.changeSetId !== input.changeSet.id ||
    !('reviewId' in owner) ||
    owner.reviewId !== input.reviewId ||
    !('stagingRootIdentity' in owner) ||
    owner.stagingRootIdentity !== input.stagingRootIdentity ||
    !('targetRootDigest' in owner) ||
    owner.targetRootDigest !== digestBuffer(Buffer.from(targetRoot)) ||
    !('targetRootIdentity' in owner) ||
    owner.targetRootIdentity !== input.targetRootIdentity ||
    !('version' in owner) ||
    owner.version !== 1 ||
    !('workspaceId' in owner) ||
    owner.workspaceId !== input.workspaceId
  ) {
    throw new Error(`Filesystem rollback preparation owner mismatch: ${input.reviewId}`);
  }

  if (preparationStats) {
    if (!preparationStats.isDirectory() || preparationStats.isSymbolicLink()) {
      throw new Error(`Unsafe filesystem rollback preparation: ${input.reviewId}`);
    }
    const preparationRealPath = await realpath(preparationRoot);
    assertPathWithinRoot(stagingRoot, preparationRealPath);
    await rm(preparationRealPath, { force: true, recursive: true });
  }
  await rm(ownerPath, { force: true });
}

/**
 * Restores an interrupted filesystem apply before a retry performs conflict detection.
 *
 * @param input Filesystem apply input.
 * @param stagingRoot Trusted staging root.
 * @param targetRoot Trusted target root.
 * @param rollbackRoot Review-specific rollback root.
 */
async function recoverFilesystemRollback(
  input: ApplyStagedFilesystemChangesInput,
  stagingRoot: string,
  targetRoot: string,
  rollbackRoot: string,
  replacementPaths: readonly string[]
): Promise<void> {
  const rollback = await readFilesystemRollbackMarker(rollbackRoot, stagingRoot, targetRoot, {
    changeSetId: input.changeSet.id,
    replacementPaths,
    reviewId: input.reviewId,
    stagingRootIdentity: input.stagingRootIdentity,
    targetRootIdentity: input.targetRootIdentity,
    workspaceId: input.workspaceId,
  });
  if (!rollback) {
    await assertFilesystemReplacementRootsAbsent(
      targetRoot,
      input.workspaceId,
      input.reviewId,
      replacementPaths
    );
    return;
  }

  await cleanupFilesystemReplacementRoots(
    targetRoot,
    input.workspaceId,
    input.reviewId,
    rollback.marker.replacementPaths
  );
  await restoreFilesystemRollback(
    input,
    targetRoot,
    rollback.rootPath,
    rollback.marker.replacementPaths
  );
  await cleanupFilesystemRollback(rollback, targetRoot, input.workspaceId, input.reviewId);
}

/**
 * Captures every pre-apply file under a durable review-specific rollback root.
 *
 * @param input Filesystem apply input.
 * @param stagingRoot Trusted staging root.
 * @param targetRoot Trusted target root.
 * @param rollbackRoot Review-specific rollback root.
 */
async function prepareFilesystemRollback(
  input: ApplyStagedFilesystemChangesInput,
  stagingRoot: string,
  targetRoot: string,
  rollbackRoot: string,
  replacementPaths: readonly string[]
): Promise<void> {
  const preparationRoot = `${rollbackRoot}.prepare`;
  const ownerPath = `${preparationRoot}.owner.json`;
  const marker: FilesystemRollbackMarker = {
    changeSetId: input.changeSet.id,
    replacementPaths: [...replacementPaths],
    reviewId: input.reviewId,
    stagingRootIdentity: input.stagingRootIdentity,
    targetRootDigest: digestBuffer(Buffer.from(targetRoot)),
    targetRootIdentity: input.targetRootIdentity,
    version: 1,
    workspaceId: input.workspaceId,
  };
  const owner = {
    changeSetId: marker.changeSetId,
    reviewId: marker.reviewId,
    stagingRootIdentity: marker.stagingRootIdentity,
    targetRootDigest: marker.targetRootDigest,
    targetRootIdentity: marker.targetRootIdentity,
    version: marker.version,
    workspaceId: marker.workspaceId,
  };
  let ownerCreated = false;
  let preparationCreated = false;

  try {
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    ownerCreated = true;
    await chmod(ownerPath, 0o600);
    await mkdir(preparationRoot, { mode: 0o700 });
    preparationCreated = true;
    await chmod(preparationRoot, 0o700);
    const preparationRealPath = await realpath(preparationRoot);
    assertPathWithinRoot(stagingRoot, preparationRealPath);

    for (const changedPath of input.changeSet.changedPaths) {
      await requireTargetMatchesBefore(input.before, targetRoot, changedPath);
      if (changedPath.status === 'added') {
        continue;
      }

      const sourcePath = await requireExistingPathWithinRoot(targetRoot, changedPath.path);
      const backupPath = await prepareWritablePathWithinRoot(
        preparationRealPath,
        `files/${changedPath.path}`
      );
      await copyFile(sourcePath, backupPath);
    }

    // ponytail: ready.json covers process restart; host-power-loss fsync needs a future repo-wide shared primitive.
    await writeFile(join(preparationRealPath, 'ready.json'), `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(preparationRealPath, rollbackRoot);
    preparationCreated = false;
    await rm(ownerPath, { force: true });
    ownerCreated = false;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (preparationCreated) {
      try {
        await rm(preparationRoot, { force: true, recursive: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (ownerCreated) {
      try {
        await rm(ownerPath, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Filesystem rollback preparation and cleanup failed.'
      );
    }
    throw error;
  }
}

/**
 * Restores all affected files from a prepared rollback root.
 *
 * @param input Filesystem apply input.
 * @param targetRoot Trusted target root.
 * @param rollbackRoot Prepared rollback root.
 * @param replacementPaths Marker-authorized deterministic replacement paths.
 */
async function restoreFilesystemRollback(
  input: ApplyStagedFilesystemChangesInput,
  targetRoot: string,
  rollbackRoot: string,
  replacementPaths: readonly string[]
): Promise<void> {
  const beforeFiles = fileEntriesByPath(input.before);
  const beforeDirectories = new Set(
    input.before.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path)
  );
  const failures: unknown[] = [];

  for (const changedPath of [...input.changeSet.changedPaths].reverse()) {
    try {
      const before = beforeFiles.get(changedPath.path) ?? null;
      const current = await readFilesystemFileState(targetRoot, changedPath.path);
      const matchesBefore = before
        ? current?.digest === before.digest && current.permissions === before.permissions
        : current === null;
      if (matchesBefore) {
        if (!before && changedPath.status === 'added') {
          await removeAddedParentDirectories(targetRoot, changedPath.path, beforeDirectories);
        }
        continue;
      }

      let matchesApplied = current === null && changedPath.status === 'deleted';
      if (changedPath.status !== 'deleted') {
        matchesApplied = Boolean(current && changedFileMatchesDeclaration(changedPath, current));
      }
      if (!matchesApplied) {
        throw new Error(`Filesystem rollback target changed after apply: ${changedPath.path}`);
      }

      const targetPath = await prepareWritablePathWithinRoot(targetRoot, changedPath.path);

      if (changedPath.status === 'added') {
        await rm(targetPath, { force: true });
        await removeAddedParentDirectories(targetRoot, changedPath.path, beforeDirectories);
        continue;
      }

      const backupPath = await requireExistingPathWithinRoot(
        rollbackRoot,
        `files/${changedPath.path}`
      );
      const backupDigest = digestBuffer(await readFile(backupPath));
      if (!before?.digest || backupDigest !== before.digest) {
        throw new Error(`Filesystem rollback backup is invalid: ${changedPath.path}`);
      }
      if (changedPath.status === 'mode_changed') {
        await chmod(targetPath, parsePermissionsSummary(before.permissions ?? ''));
        continue;
      }
      const normalizedPath = normalizeRelativePath(changedPath.path);
      if (!replacementPaths.includes(normalizedPath)) {
        throw new Error(`Filesystem rollback replacement is unproven: ${changedPath.path}`);
      }
      await replaceFileFromSource(
        backupPath,
        targetPath,
        before.permissions ?? undefined,
        filesystemReplacementRoot(targetRoot, input.workspaceId, input.reviewId, normalizedPath)
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Filesystem rollback found conflicting target state.');
  }
}

/**
 * Removes empty parent directories created solely for one rolled-back added file.
 *
 * @param targetRoot Trusted target root.
 * @param relativePath Rolled-back added file path.
 * @param beforeDirectories Directories that existed in the base snapshot.
 */
async function removeAddedParentDirectories(
  targetRoot: string,
  relativePath: string,
  beforeDirectories: ReadonlySet<string>
): Promise<void> {
  let parent = normalizeRelativePath(dirname(relativePath));

  while (parent && parent !== '.' && !beforeDirectories.has(parent)) {
    let parentPath: string;
    try {
      parentPath = await requireExistingPathWithinRoot(targetRoot, parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    try {
      await rmdir(parentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        return;
      }
      throw error;
    }
    parent = normalizeRelativePath(dirname(parent));
  }
}

/**
 * Recursively collects product-safe snapshot entries.
 *
 * @param rootPath Absolute root being scanned.
 * @param relativeDirectory Workspace-relative directory.
 * @param ignoredPathPrefixes Ignored path prefixes.
 * @param entries Mutable entries accumulator.
 */
async function collectEntries(
  rootPath: string,
  relativeDirectory: string,
  ignoredPathPrefixes: readonly string[],
  entries: FilesystemSnapshotEntry[]
): Promise<void> {
  const directoryPath = relativeDirectory ? join(rootPath, relativeDirectory) : rootPath;
  const dirents = await readdir(directoryPath, { withFileTypes: true });

  for (const dirent of dirents) {
    const relativePath = normalizeRelativePath(
      relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name
    );

    assertSafeRelativePath(relativePath);

    const ignoreReason = ignoreReasonFor(relativePath, ignoredPathPrefixes);

    if (ignoreReason) {
      entries.push(ignoredEntry(relativePath, ignoreReason));
      continue;
    }

    const absolutePath = join(rootPath, relativePath);

    if (dirent.isSymbolicLink()) {
      entries.push(ignoredEntry(relativePath, 'symlink'));
      continue;
    }

    const stats = await stat(absolutePath);

    if (dirent.isDirectory()) {
      entries.push({
        digest: null,
        ignoreReason: null,
        kind: 'directory',
        path: relativePath,
        permissions: permissionsSummary(stats.mode),
        size: null,
        writable: true,
      });
      await collectEntries(rootPath, relativePath, ignoredPathPrefixes, entries);
      continue;
    }

    if (dirent.isFile()) {
      const content = await readFile(absolutePath);

      entries.push({
        digest: digestBuffer(content),
        ignoreReason: null,
        kind: 'file',
        path: relativePath,
        permissions: permissionsSummary(stats.mode),
        size: stats.size,
        writable: true,
      });
    }
  }
}

/**
 * Detects target conflicts before filesystem apply mutates the workspace.
 *
 * @param input Filesystem apply input.
 * @returns Product-safe conflict summaries.
 */
async function detectConflicts(input: ApplyStagedFilesystemChangesInput): Promise<string[]> {
  const beforeFiles = fileEntriesByPath(input.before);
  const conflicts: string[] = [];
  const stagingRoot = await realpath(input.stagingRoot);
  const targetRoot = await realpath(input.targetRoot);

  for (const changedPath of input.changeSet.changedPaths) {
    assertSafeRelativePath(changedPath.path);

    if (changedPath.status !== 'deleted') {
      let stagedState: Awaited<ReturnType<typeof readFilesystemFileState>>;
      try {
        stagedState = await readFilesystemFileState(stagingRoot, changedPath.path);
      } catch {
        stagedState = null;
      }
      if (!stagedState || !changedFileMatchesDeclaration(changedPath, stagedState)) {
        conflicts.push(`Staged path changed since review: ${changedPath.path}`);
        continue;
      }
    }

    const targetPath = join(targetRoot, changedPath.path);
    const before = beforeFiles.get(changedPath.path);
    const exists = existsSync(targetPath);
    let existingTargetPath: string | null = null;

    if (changedPath.status === 'added') {
      if (exists) {
        conflicts.push(`Target path already exists: ${changedPath.path}`);
        continue;
      }

      const parentConflict = await detectWritableParentConflict(targetRoot, changedPath.path);

      if (parentConflict) {
        conflicts.push(parentConflict);
      }
      continue;
    }

    if (!before) {
      conflicts.push(`Missing base manifest entry: ${changedPath.path}`);
      continue;
    }

    if (!exists) {
      conflicts.push(`Target path is missing: ${changedPath.path}`);
      continue;
    }

    try {
      existingTargetPath = await requireExistingPathWithinRoot(targetRoot, changedPath.path);
    } catch {
      conflicts.push(`Target path escapes workspace root: ${changedPath.path}`);
      continue;
    }

    const currentStats = await stat(existingTargetPath);

    if (!currentStats.isFile()) {
      conflicts.push(`Target path is not a file: ${changedPath.path}`);
      continue;
    }

    const currentDigest = digestBuffer(await readFile(existingTargetPath));

    if (currentDigest !== before.digest) {
      conflicts.push(`Target path changed since snapshot: ${changedPath.path}`);
      continue;
    }

    if (before.permissions) {
      const currentPermissions = permissionsSummary(currentStats.mode);

      if (currentPermissions !== before.permissions) {
        conflicts.push(`Target permissions changed since snapshot: ${changedPath.path}`);
      }
    }
  }

  return conflicts;
}

/**
 * Detects parent-path conflicts that would prevent a new file from being written safely.
 *
 * @param rootRealPath Real path for the trusted root.
 * @param relativePath Workspace-relative file path.
 * @returns Product-safe conflict summary, or null when parents are writable.
 */
async function detectWritableParentConflict(
  rootRealPath: string,
  relativePath: string
): Promise<string | null> {
  const segments = normalizeRelativePath(relativePath).split('/');

  for (let index = 0; index < segments.length - 1; index += 1) {
    const parentRelativePath = segments.slice(0, index + 1).join('/');
    const parentPath = join(rootRealPath, parentRelativePath);

    if (!existsSync(parentPath)) {
      continue;
    }

    const parentStats = await lstat(parentPath);

    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      return `Target parent is not a directory: ${parentRelativePath}`;
    }

    const parentRealPath = await realpath(parentPath);

    if (!pathWithinRoot(rootRealPath, parentRealPath)) {
      return `Target parent escapes workspace root: ${parentRelativePath}`;
    }
  }

  return null;
}

/**
 * Reads one regular file without accepting symlink path aliases.
 *
 * @param rootRealPath Trusted real root path.
 * @param relativePath Workspace-relative file path.
 * @returns Content and permission state, or null when the path is absent.
 */
async function readFilesystemFileState(
  rootRealPath: string,
  relativePath: string
): Promise<{
  readonly digest: string;
  readonly permissions: string;
  readonly size: number;
} | null> {
  let filePath: string;
  try {
    filePath = await requireExistingPathWithinRoot(rootRealPath, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const stats = await lstat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Filesystem path is not a regular file: ${relativePath}`);
  }
  return {
    digest: digestBuffer(await readFile(filePath)),
    permissions: permissionsSummary(stats.mode),
    size: stats.size,
  };
}

/**
 * Requires one canonical filesystem root to retain its registered device and inode identity.
 *
 * @param rootPath Canonical root path.
 * @param expectedIdentity Registered device and inode identity.
 */
async function requireFilesystemRootIdentity(
  rootPath: string,
  expectedIdentity: string
): Promise<void> {
  const stats = await stat(rootPath, { bigint: true });
  const identity = `${stats.dev}:${stats.ino}`;
  if (!stats.isDirectory() || identity !== expectedIdentity) {
    throw new Error('Filesystem workspace root identity changed after review staging.');
  }
}

/**
 * Requires one target path to still match the immutable pre-worker snapshot.
 *
 * @param before Base filesystem manifest.
 * @param targetRoot Trusted target root.
 * @param changedPath Reviewed changed-path metadata.
 * @throws Error when a concurrent edit, chmod, creation, deletion, or path-kind change is found.
 */
async function requireTargetMatchesBefore(
  before: FilesystemSnapshotManifest,
  targetRoot: string,
  changedPath: WorkspaceChangeSet['changedPaths'][number]
): Promise<void> {
  const beforeEntry = fileEntriesByPath(before).get(changedPath.path) ?? null;
  const current = await readFilesystemFileState(targetRoot, changedPath.path);
  const matches = beforeEntry
    ? current?.digest === beforeEntry.digest &&
      current.permissions === beforeEntry.permissions &&
      current.size === beforeEntry.size
    : current === null && changedPath.status === 'added';
  if (!matches) {
    throw new Error(`Filesystem target changed after review preflight: ${changedPath.path}`);
  }
}

/**
 * Checks one staged/source file against its reviewed change declaration.
 *
 * @param changedPath Reviewed changed-path metadata.
 * @param state Current regular-file state.
 * @returns True when content, size, and permissions match the declaration.
 */
function changedFileMatchesDeclaration(
  changedPath: WorkspaceChangeSet['changedPaths'][number],
  state: { readonly digest: string; readonly permissions: string; readonly size: number }
): boolean {
  return (
    typeof changedPath.digest === 'string' &&
    changedPath.digest === state.digest &&
    typeof changedPath.size === 'number' &&
    changedPath.size === state.size &&
    typeof changedPath.newPermissions === 'string' &&
    changedPath.newPermissions === state.permissions
  );
}

/**
 * Replaces one file through an operation-owned sibling and atomic rename.
 *
 * @param sourcePath Trusted source file.
 * @param targetPath Validated target file path.
 * @param permissions Optional final POSIX permission summary.
 * @param replacement Deterministic root authorized by its enclosing product boundary.
 */
async function replaceFileFromSource(
  sourcePath: string,
  targetPath: string,
  permissions: string | undefined,
  replacement: ReturnType<typeof filesystemReplacementRoot>
): Promise<void> {
  try {
    const targetStats = await lstat(targetPath);
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw new Error('Filesystem target is not a regular file.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  let temporaryRootCreated = false;
  let operationError: unknown = null;
  try {
    await mkdir(replacement.rootPath, { mode: 0o700 });
    temporaryRootCreated = true;
    await chmod(replacement.rootPath, 0o700);
    const temporaryPath = join(replacement.rootPath, 'content');
    await copyFile(sourcePath, temporaryPath);
    if (permissions) {
      await chmod(temporaryPath, parsePermissionsSummary(permissions));
    }
    await rename(temporaryPath, targetPath);
  } catch (error) {
    operationError = error;
  }

  try {
    if (temporaryRootCreated) {
      await removeFilesystemReplacementRoot(replacement);
    }
  } catch (cleanupError) {
    if (operationError) {
      throw new AggregateError(
        [operationError, cleanupError],
        'Filesystem file replacement and cleanup failed.'
      );
    }
    throw cleanupError;
  }
  if (operationError) {
    throw operationError;
  }
}

/**
 * Resolves an existing path and verifies it remains under its declared root.
 *
 * @param rootRealPath Real path for the trusted root.
 * @param relativePath Workspace-relative candidate path.
 * @returns Existing absolute path when it resolves inside the root.
 * @throws Error when the path escapes through symlinks or traversal.
 */
async function requireExistingPathWithinRoot(
  rootRealPath: string,
  relativePath: string
): Promise<string> {
  assertSafeRelativePath(relativePath);
  const segments = normalizeRelativePath(relativePath).split('/');
  let currentPath = rootRealPath;

  for (const [index, segment] of segments.entries()) {
    const candidatePath = join(currentPath, segment);
    const stats = await lstat(candidatePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`unsafe filesystem symlink path: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`unsafe filesystem path parent: ${relativePath}`);
    }
    currentPath = await realpath(candidatePath);
    assertPathWithinRoot(rootRealPath, currentPath);
  }

  return currentPath;
}

/**
 * Prepares a writable path and verifies its parent remains under its declared root.
 *
 * @param rootRealPath Real path for the trusted root.
 * @param relativePath Workspace-relative candidate path.
 * @returns Absolute path that may be safely written.
 * @throws Error when the path parent escapes through symlinks or traversal.
 */
async function prepareWritablePathWithinRoot(
  rootRealPath: string,
  relativePath: string
): Promise<string> {
  assertSafeRelativePath(relativePath);
  const segments = normalizeRelativePath(relativePath).split('/');
  const fileName = segments.pop();
  if (!fileName) {
    throw new Error(`Unsafe filesystem workspace path: ${relativePath}`);
  }
  let parentPath = rootRealPath;

  for (const segment of segments) {
    const candidatePath = join(parentPath, segment);
    let created = false;
    try {
      await mkdir(candidatePath, { mode: 0o755 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    if (created) {
      await chmod(candidatePath, 0o755);
    }
    const stats = await lstat(candidatePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`unsafe filesystem path parent: ${relativePath}`);
    }
    parentPath = await realpath(candidatePath);
    assertPathWithinRoot(rootRealPath, parentPath);
  }

  return join(parentPath, fileName);
}

/**
 * Verifies that one resolved path is contained by a trusted root.
 *
 * @param rootRealPath Real path for the trusted root.
 * @param resolvedPath Resolved candidate path.
 * @throws Error when the candidate is outside the root.
 */
function assertPathWithinRoot(rootRealPath: string, resolvedPath: string): void {
  if (!pathWithinRoot(rootRealPath, resolvedPath)) {
    throw new Error(`unsafe filesystem path outside root: ${resolvedPath}`);
  }
}

/**
 * Checks whether one resolved path is contained by a trusted root.
 *
 * @param rootRealPath Real path for the trusted root.
 * @param resolvedPath Resolved candidate path.
 * @returns True when the candidate is inside the trusted root.
 */
function pathWithinRoot(rootRealPath: string, resolvedPath: string): boolean {
  return resolvedPath === rootRealPath || resolvedPath.startsWith(`${rootRealPath}${sep}`);
}

/**
 * Converts file entries into a lookup table.
 *
 * @param manifest Filesystem snapshot manifest.
 * @returns File entries keyed by relative path.
 */
function fileEntriesByPath(
  manifest: FilesystemSnapshotManifest
): Map<string, FilesystemSnapshotEntry> {
  return new Map(
    manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry])
  );
}

/**
 * Creates an ignored manifest entry.
 *
 * @param path Workspace-relative path.
 * @param reason Ignore reason.
 * @returns Ignored entry.
 */
function ignoredEntry(path: string, reason: string): FilesystemSnapshotEntry {
  return {
    digest: null,
    ignoreReason: reason,
    kind: 'ignored',
    path,
    permissions: null,
    size: null,
    writable: false,
  };
}

/**
 * Finds why a path should be ignored.
 *
 * @param path Workspace-relative path.
 * @param ignoredPathPrefixes Ignored prefixes.
 * @returns Ignore reason, or null.
 */
function ignoreReasonFor(path: string, ignoredPathPrefixes: readonly string[]): string | null {
  const prefix = ignoredPathPrefixes.find(
    (candidate) => path === candidate || path.startsWith(`${candidate}/`)
  );

  return prefix ? `ignored-prefix:${prefix}` : null;
}

/**
 * Derives the private rollback directory name for one review.
 *
 * @param workspaceId Workspace that owns the review-local id.
 * @param operationId Review or change-set id that owns the temporary root.
 * @returns Stable internal rollback directory name.
 */
function filesystemRollbackDirectoryName(workspaceId: string, reviewId: string): string {
  return `.openkit-workspace-rollback-${createHash('sha256')
    .update(`${workspaceId}\0${reviewId}`)
    .digest('hex')}`;
}

/**
 * Derives the exact atomic replacement root owned by one reviewed path.
 *
 * @param boundaryRoot Canonical product-owned root containing the temporary sibling.
 * @param workspaceId Workspace that owns the review-local id.
 * @param reviewId Workspace review id.
 * @param relativePath Reviewed workspace-relative path.
 * @returns Deterministic sibling root plus its exact ownership lineage.
 */
function filesystemReplacementRoot(
  boundaryRoot: string,
  workspaceId: string,
  operationId: string,
  relativePath: string
): {
  readonly boundaryRoot: string;
  readonly relativePath: string;
  readonly rootPath: string;
} {
  const normalizedPath = normalizeRelativePath(relativePath);
  return {
    boundaryRoot,
    relativePath: normalizedPath,
    rootPath: join(
      boundaryRoot,
      dirname(normalizedPath),
      `.openkit-write-${createHash('sha256')
        .update(`${workspaceId}\0${operationId}\0${normalizedPath}`)
        .digest('hex')}`
    ),
  };
}

/**
 * Fails closed when any expected replacement root exists without rollback proof.
 *
 * @param targetRoot Canonical target root.
 * @param workspaceId Workspace that owns the review.
 * @param reviewId Review that owns the expected paths.
 * @param replacementPaths Exact paths that use deterministic replacement.
 */
async function assertFilesystemReplacementRootsAbsent(
  targetRoot: string,
  workspaceId: string,
  reviewId: string,
  replacementPaths: readonly string[]
): Promise<void> {
  for (const relativePath of replacementPaths) {
    const replacement = filesystemReplacementRoot(targetRoot, workspaceId, reviewId, relativePath);
    if (await lstatIfExists(replacement.rootPath)) {
      throw new Error(`Unproven filesystem replacement root: ${relativePath}`);
    }
  }
}

/**
 * Removes exact replacement roots listed by a validated rollback marker.
 *
 * @param targetRoot Canonical target root.
 * @param workspaceId Workspace that owns the review.
 * @param reviewId Review that owns the listed paths.
 * @param replacementPaths Marker-authorized normalized paths.
 */
async function cleanupFilesystemReplacementRoots(
  targetRoot: string,
  workspaceId: string,
  reviewId: string,
  replacementPaths: readonly string[]
): Promise<void> {
  for (const relativePath of replacementPaths) {
    await removeFilesystemReplacementRoot(
      filesystemReplacementRoot(targetRoot, workspaceId, reviewId, relativePath)
    );
  }
}

/**
 * Removes one exact replacement root after its caller validates rollback ownership.
 *
 * @param input Marker-authorized deterministic replacement root.
 */
async function removeFilesystemReplacementRoot(
  input: ReturnType<typeof filesystemReplacementRoot>
): Promise<void> {
  const rootStats = await lstatIfExists(input.rootPath);
  if (!rootStats) {
    return;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Unsafe filesystem replacement root: ${input.relativePath}`);
  }
  const rootRealPath = await realpath(input.rootPath);
  assertPathWithinRoot(input.boundaryRoot, rootRealPath);
  await rm(rootRealPath, { force: true, recursive: true });
}

/**
 * Normalizes a workspace-relative path.
 *
 * @param path Path to normalize.
 * @returns POSIX-like relative path.
 */
function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Rejects unsafe relative paths.
 *
 * @param path Workspace-relative path.
 * @throws Error when the path can escape the workspace root.
 */
function assertSafeRelativePath(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    unsafeRelativePathPattern.test(path) ||
    path.includes('\0')
  ) {
    throw new Error(`Unsafe filesystem workspace path: ${path}`);
  }
}

/**
 * Formats POSIX permissions for manifest entries.
 *
 * @param mode Stat mode.
 * @returns Octal permission summary.
 */
function permissionsSummary(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/**
 * Parses one POSIX permission summary into a chmod mode.
 *
 * @param permissions Permission summary such as `0644`.
 * @returns Numeric chmod mode.
 */
function parsePermissionsSummary(permissions: string): number {
  if (!/^0[0-7]{3}$/.test(permissions)) {
    throw new Error(`Invalid permission summary: ${permissions}`);
  }

  return Number.parseInt(permissions.slice(1), 8);
}

/**
 * Computes a SHA-256 digest for a buffer.
 *
 * @param value Buffer to hash.
 * @returns Digest string.
 */
function digestBuffer(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Computes a SHA-256 digest for JSON-compatible data.
 *
 * @param value Value to hash.
 * @returns Digest string.
 */
function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
