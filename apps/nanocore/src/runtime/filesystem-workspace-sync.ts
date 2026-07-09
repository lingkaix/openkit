import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import {
  type WorkspaceApplyResult,
  WorkspaceApplyResultSchema,
  type WorkspaceChangeSet,
  WorkspaceChangeSetSchema,
} from '@openkit/app-api-schemas';

const defaultIgnoredPathPrefixes = ['.git', 'node_modules'];
const unsafeRelativePathPattern = /(^|\/)\.\.(\/|$)/;

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
  /** Target workspace root to mutate after conflict checks pass. */
  readonly targetRoot: string;
  /** Apply timestamp. */
  readonly appliedAt: string;
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

    const sourcePath = await requireExistingPathWithinRoot(sourceRoot, changedPath.path);
    const targetPath = await prepareWritablePathWithinRoot(stagingRoot, changedPath.path);

    await copyFile(sourcePath, targetPath);
    stagedPaths.push(changedPath.path);
  }

  return { stagedPaths };
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
  const conflicts = await detectConflicts(input);
  const stagingRoot = await realpath(input.stagingRoot);
  const targetRoot = await realpath(input.targetRoot);

  if (conflicts.length > 0) {
    return WorkspaceApplyResultSchema.parse({
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
  }

  for (const changedPath of input.changeSet.changedPaths) {
    assertSafeRelativePath(changedPath.path);

    const targetPath = await prepareWritablePathWithinRoot(targetRoot, changedPath.path);

    if (changedPath.status === 'deleted') {
      await rm(targetPath, { force: true });
      continue;
    }

    const stagedPath = await requireExistingPathWithinRoot(stagingRoot, changedPath.path);

    await copyFile(stagedPath, targetPath);

    if (changedPath.newPermissions) {
      await chmod(targetPath, parsePermissionsSummary(changedPath.newPermissions));
    }
  }

  return WorkspaceApplyResultSchema.parse({
    appliedAt: input.appliedAt,
    appliedPaths: input.changeSet.changedPaths.map((entry) => entry.path),
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
  const targetRoot = await realpath(input.targetRoot);

  for (const changedPath of input.changeSet.changedPaths) {
    assertSafeRelativePath(changedPath.path);

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

    if (changedPath.status === 'mode_changed' && before.permissions) {
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

    const parentStats = await stat(parentPath);

    if (!parentStats.isDirectory()) {
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
  const resolvedPath = await realpath(join(rootRealPath, relativePath));
  assertPathWithinRoot(rootRealPath, resolvedPath);
  return resolvedPath;
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
  const targetPath = join(rootRealPath, relativePath);
  const parentPath = dirname(targetPath);
  await mkdir(parentPath, { recursive: true });
  const parentRealPath = await realpath(parentPath);
  assertPathWithinRoot(rootRealPath, parentRealPath);
  return targetPath;
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
