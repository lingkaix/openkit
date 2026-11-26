import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import {
  DATA_ROOT_BACKUP_FORMAT_VERSION,
  type DataRootBackupManifest,
  parseDataRootBackupManifest,
} from '@openkit/config-schema';
import { compareCodeUnits, DataRootBackupIdSchema, DeploymentIdSchema } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import {
  assertCanonicalRegularFile,
  copyBackupTree,
  copyMissingBackupDefinitions,
  copyPortableOriginalFile,
  createPrivateTree,
  ensureCanonicalDirectory,
  readLayoutDirectory,
  removePrivateTree,
  syncCanonicalDirectory,
  syncCanonicalTree,
} from '@openkit/storage';
import Database from 'better-sqlite3';
import { writeFileAtomic } from './canonical-write-capacity.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import {
  assertCoreBaseline,
  inspectServerOwnerFile,
  openSupportedScopeReadOnlySqlite,
  verifyServerOwnerRestoreCopy,
} from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import {
  assertNativeBaseline,
  SPLIT_STORAGE_JOURNALS,
  type SplitStorageOwner,
  type StorageMigrationScope,
} from './migrate.js';

/** File name for the data-root backup manifest. */
export const DATA_ROOT_BACKUP_MANIFEST_FILE = 'openkit-data-root-backup.json';

/** Input for writing one cold data-root backup manifest. */
export interface WriteColdDataRootBackupManifestInput {
  /** Root of the copied data root to inventory. */
  backupRoot: string;
  /** Stable backup record id. */
  backupId: string;
  /** Source deployment id recorded in backup lineage. */
  sourceDeploymentId: string;
  /** Timestamp captured when backup copy started. */
  startedAt: string;
  /** Timestamp captured when backup copy completed. */
  completedAt: string;
}

/** Input for writing one hot data-root backup. */
export interface WriteHotDataRootBackupInput {
  /** Live data root to copy. */
  dataRoot: string;
  /** Backup root to replace with the captured copy. */
  backupRoot: string;
  /** Stable backup record id. */
  backupId: string;
  /** Source deployment id recorded in backup lineage. */
  sourceDeploymentId: string;
  /** Timestamp captured before file copy starts. */
  startedAt: string;
  /** Timestamp captured after SQLite snapshots finish. */
  completedAt: string;
}

/** Input for verifying one data-root backup manifest. */
export interface VerifyDataRootBackupManifestInput {
  /** Backup root directory to verify. */
  backupRoot: string;
  /** Required-feature ids supported by the verifier. */
  supportedFeatures?: readonly string[];
}

/** Input for restoring one verified data-root backup. */
export interface RestoreDataRootBackupInput {
  /** Backup root to verify and restore from. */
  backupRoot: string;
  /** Target data root to replace. */
  dataRoot: string;
  /** Optional same-filesystem staging root. Defaults beside `dataRoot`. */
  stagingRoot?: string;
}

/** Result returned by data-root backup verification. */
export interface VerifiedDataRootBackupManifest {
  /** Parsed backup manifest. */
  manifest: DataRootBackupManifest;
  /** Inventory files whose bytes and digests were checked. */
  checkedFiles: string[];
}

/** One regular file in a verified tree inventory. */
export interface RegularFileInventoryEntry {
  /** File size in bytes. */
  readonly bytes: number;
  /** SHA-256 digest over the exact file bytes. */
  readonly digest: string;
  /** Slash-separated path relative to the inventory root. */
  readonly path: string;
}

/** Input for copying one stopped data root into a new external cold-backup root. */
export interface CopyColdDataRootInput {
  /** New external backup destination. */
  readonly backupRoot: string;
  /** Stopped source data root. */
  readonly dataRoot: string;
  /** Omit only the fixed data-root lock owned by the active maintenance process. */
  readonly omitActiveDataRootLock?: true;
}

/**
 * Inventories every regular file under one real directory without following links.
 *
 * @param root Directory whose regular files should be inventoried.
 * @returns Stable path, size, and digest entries.
 * @throws Error when the root or a descendant is linked or unsupported.
 */
export function inventoryRegularFiles(root: string): RegularFileInventoryEntry[] {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Inventory root must be a real directory: ${root}`);
  }

  return listRegularBackupFiles(root)
    .map((path) => {
      const filePath = join(root, path);
      return { bytes: statSync(filePath).size, digest: digestFile(filePath), path };
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path));
}

/**
 * Rejects destructive or recursive external cold-backup destinations.
 *
 * @param dataRoot Source data root.
 * @param backupRoot Caller-selected external destination.
 * @throws Error when either tree contains the other or the destination already exists.
 */
export function assertExternalColdBackupDestination(dataRoot: string, backupRoot: string): void {
  const resolvedBackup = resolvePotentialPath(backupRoot);
  const resolvedDataRoot = resolvePotentialPath(dataRoot);

  if (dirname(resolve(backupRoot)) === resolve(backupRoot)) {
    throw new Error('External backup root must not be a filesystem root.');
  }
  if (
    resolvedBackup === resolvedDataRoot ||
    resolvedBackup.startsWith(`${resolvedDataRoot}${sep}`) ||
    resolvedDataRoot.startsWith(`${resolvedBackup}${sep}`)
  ) {
    throw new Error('External backup root must be separate from the source data root.');
  }
  if (existsSync(backupRoot)) {
    throw new Error('External backup root must not already exist.');
  }
}

/**
 * Copies one stopped data root to a new external cold-backup destination.
 *
 * @param input Source, destination, and fixed maintenance-lock handling.
 * @returns Mode of an omitted previous backup manifest, when present.
 * @throws Error when the copy fails.
 */
export function copyColdDataRoot(input: CopyColdDataRootInput): number | undefined {
  return copyDataRootForBackup(input, true);
}

/** Copies retained source bytes while reserving the destination manifest for final publication. */
function copyDataRootForBackup(input: CopyColdDataRootInput, stopped: boolean): number | undefined {
  const omittedLock = input.omitActiveDataRootLock
    ? resolve(input.dataRoot, 'server', 'runtime', 'nanocore.lock')
    : null;
  const sourceManifest = resolve(input.dataRoot, DATA_ROOT_BACKUP_MANIFEST_FILE);
  let copiedManifestMode: number | undefined;

  ensureCanonicalDirectory(dirname(resolve(input.backupRoot)), 0o777, 'created-entries');
  copyBackupTree(input.dataRoot, input.backupRoot, {
    errorOnExist: stopped,
    preserveTimestamps: stopped,
    filter: (source) => {
      const path = resolve(source);
      if (path === sourceManifest) {
        copiedManifestMode = assertCanonicalRegularFile(path).mode & 0o7777;
        return false;
      }
      return path !== omittedLock;
    },
  });
  return copiedManifestMode;
}

/**
 * Verifies that a backup manifest exactly matches a captured source inventory.
 *
 * @param backup Verified external cold backup.
 * @param predecessorInventory Complete persistent predecessor inventory.
 * @throws Error when any path, size, or digest differs.
 */
export function assertBackupMatchesPredecessor(
  backup: VerifiedDataRootBackupManifest,
  predecessorInventory: readonly RegularFileInventoryEntry[]
): void {
  const backupInventory = backup.manifest.contentInventory.map((entry) => ({
    bytes: entry.bytes,
    digest: entry.digest,
    path: entry.path,
  }));

  const retainedInventory = predecessorInventory.filter(
    (entry) => entry.path !== DATA_ROOT_BACKUP_MANIFEST_FILE
  );
  if (JSON.stringify(retainedInventory) !== JSON.stringify(backupInventory)) {
    throw new Error('Verified backup does not match the complete predecessor inventory.');
  }
}

/** Writes one storage-maintenance JSON document through a same-directory temporary file. */
export function writeStorageJsonAtomically(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o666 & ~process.umask());
}

/**
 * Writes a cold backup manifest for an already copied data root and verifies the result.
 *
 * @param input Backup metadata and root to inventory.
 * @param copiedMode Mode of any prior manifest omitted by the cold tree copy.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when an identifier is invalid or the written manifest does not verify.
 */
export function writeColdDataRootBackupManifest(
  input: WriteColdDataRootBackupManifestInput,
  copiedMode?: number
): VerifiedDataRootBackupManifest {
  DataRootBackupIdSchema.parse(input.backupId);
  DeploymentIdSchema.parse(input.sourceDeploymentId);
  return writeDataRootBackupManifest(
    {
      backupRoot: input.backupRoot,
      backupId: input.backupId,
      sourceDeploymentId: input.sourceDeploymentId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      backupMode: 'cold',
      consistency: 'clean',
    },
    copiedMode
  );
}

/**
 * Captures the live tree, SQLite snapshots and verified manifest. The serving caller holds the
 * Data Root publishers and native writer pool paused until this capture settles.
 *
 * @param input Live data root and backup destination.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when an identifier is invalid, or copy, SQLite backup, or manifest verification fails.
 */
export async function writeHotDataRootBackup(
  input: WriteHotDataRootBackupInput
): Promise<VerifiedDataRootBackupManifest> {
  DataRootBackupIdSchema.parse(input.backupId);
  DeploymentIdSchema.parse(input.sourceDeploymentId);
  assertBackupRootOutsideDataRoot(input.dataRoot, input.backupRoot);
  const appsBefore = listLightAppDirectoryPaths(input.dataRoot);
  rmSync(input.backupRoot, { recursive: true, force: true });
  const copiedMode = copyDataRootForBackup(input, false);

  snapshotSqliteDatabases(input.dataRoot, input.backupRoot);
  const appsAfter = listLightAppDirectoryPaths(input.dataRoot);
  if (appsBefore.join('\n') !== appsAfter.join('\n')) {
    throw new Error('Light App inventory changed during hot backup capture.');
  }
  copyMissingLightAppDefinitions(input.dataRoot, input.backupRoot);
  assertLightAppDefinitionCoverage(input.backupRoot);

  return writeDataRootBackupManifest(
    {
      backupRoot: input.backupRoot,
      backupId: input.backupId,
      sourceDeploymentId: input.sourceDeploymentId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      backupMode: 'hot',
      consistency: 'crash-consistent',
    },
    copiedMode
  );
}

/**
 * Uses the public asynchronous SQLite backup API in one child while Core remains paused.
 * Recovery snapshots are immutable digest-bound bytes and must keep their original headers. Mutable database captures become standalone DELETE-journal images before inventory; opening them for inspection must not create unlisted WAL sidecars.
 *
 * @param dataRoot Live source tree.
 * @param backupRoot Already copied destination tree.
 * @throws Error when the child cannot capture every database.
 */
function snapshotSqliteDatabases(dataRoot: string, backupRoot: string): void {
  const databases = listRegularBackupFiles(dataRoot)
    .filter(
      (path) =>
        path.endsWith('.sqlite') &&
        !/^workspaces\/[^/]+\/light-apps\/[^/]+\/snapshots\/[^/]+\.sqlite$/.test(path)
    )
    .map((path) => ({ source: join(dataRoot, path), destination: join(backupRoot, path) }));
  if (!databases.length) return;

  const result = spawnSync(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `const { readFileSync } = require('node:fs');
const { nativeModule, databases } = JSON.parse(readFileSync(0, 'utf8'));
const Database = require(nativeModule);
(async () => {
  for (const { source, destination } of databases) {
    const database = new Database(source, { fileMustExist: true, readonly: true });
    try {
      database.pragma('query_only = ON');
      await database.backup(destination);
    } finally {
      database.close();
    }
    const captured = new Database(destination, { fileMustExist: true });
    try {
      if (captured.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
        throw new Error('Backup capture requires a standalone SQLite image.');
      }
    } finally {
      captured.close();
    }
  }
})().catch(() => { process.exitCode = 1; });`,
    ],
    {
      input: JSON.stringify({
        nativeModule: createRequire(import.meta.url).resolve('better-sqlite3'),
        databases,
      }),
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['pipe', 'ignore', 'ignore'],
    }
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('SQLite backup capture failed.');
  }
}

/** Internal input for writing a data-root backup manifest. */
interface WriteDataRootBackupManifestInput extends WriteColdDataRootBackupManifestInput {
  /** Backup capture mode. */
  backupMode: 'cold' | 'hot';
  /** Backup consistency marker. */
  consistency: 'clean' | 'crash-consistent';
}

/**
 * Writes a backup manifest for a captured data root and verifies the result.
 *
 * @param input Backup metadata and root to inventory.
 * @param copiedMode Mode of any prior manifest omitted by the capture.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when an identifier is invalid or the written manifest does not verify.
 */
function writeDataRootBackupManifest(
  input: WriteDataRootBackupManifestInput,
  copiedMode: number | undefined
): VerifiedDataRootBackupManifest {
  // Complete SQLite-backed definition inspection before sealing its derived sidecars in the inventory.
  assertLightAppDefinitionCoverage(input.backupRoot);
  const contentInventory = inventoryRegularFiles(input.backupRoot).filter(
    (entry) => entry.path !== DATA_ROOT_BACKUP_MANIFEST_FILE
  );
  const manifest: DataRootBackupManifest = {
    schemaVersion: 1,
    recordType: 'data-root-backup',
    id: input.backupId,
    ownerScope: 'server',
    lineage: {},
    createdAt: input.completedAt,
    updatedAt: input.completedAt,
    contentDigest: digestText(JSON.stringify(contentInventory)),
    redactionLevel: 'metadata',
    sensitivity: 'internal',
    requiredFeatures: [],
    extensions: {},
    sourceDeploymentId: input.sourceDeploymentId,
    backupStartedAt: input.startedAt,
    backupCompletedAt: input.completedAt,
    backupMode: input.backupMode,
    consistency: input.consistency,
    backupFormatVersion: DATA_ROOT_BACKUP_FORMAT_VERSION,
    contentInventory,
  };

  const manifestPath = join(input.backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE);
  syncCanonicalTree(input.backupRoot);
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { copiedMode });
  syncCanonicalDirectory(dirname(resolve(input.backupRoot)));
  return verifyDataRootBackupInventory({ backupRoot: input.backupRoot });
}

/**
 * Verifies a data-root backup manifest against the files currently present in the backup root.
 *
 * @param input Backup root and supported feature set.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when the manifest, inventory, digest, bytes, or file set is invalid.
 */
export function verifyDataRootBackupManifest(
  input: VerifyDataRootBackupManifestInput
): VerifiedDataRootBackupManifest {
  const verified = verifyDataRootBackupInventory(input);
  assertLightAppDefinitionCoverage(input.backupRoot);
  return verified;
}

/** Verifies source bytes without opening SQLite or creating WAL caches in a sealed backup. */
function verifyDataRootBackupInventory(
  input: VerifyDataRootBackupManifestInput
): VerifiedDataRootBackupManifest {
  const originalManifest = JSON.parse(
    readFileSync(join(input.backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE), 'utf8')
  );
  const manifest = parseDataRootBackupManifest(originalManifest, {
    supportedFeatures: input.supportedFeatures ?? [],
  });
  // The writer hashes its stored field order, which the schema parser can change.
  if (manifest.contentDigest !== digestText(JSON.stringify(originalManifest.contentInventory))) {
    throw new Error('Backup manifest content digest does not match its inventory.');
  }
  const expected = new Map(manifest.contentInventory.map((entry) => [entry.path, entry]));
  const actual = listRegularBackupFiles(input.backupRoot).filter(
    (path) => path !== DATA_ROOT_BACKUP_MANIFEST_FILE
  );

  for (const path of actual) {
    if (!expected.has(path)) {
      throw new Error(`Backup file missing from inventory: ${path}`);
    }
  }

  for (const entry of manifest.contentInventory) {
    const path = join(input.backupRoot, entry.path);
    const stat = statSync(path);

    if (!stat.isFile()) {
      throw new Error(`Backup inventory entry is not a regular file: ${entry.path}`);
    }
    if (stat.size !== entry.bytes) {
      throw new Error(`Size mismatch for backup file ${entry.path}`);
    }
    if (digestFile(path) !== entry.digest) {
      throw new Error(`Digest mismatch for backup file ${entry.path}`);
    }
  }
  return { manifest, checkedFiles: manifest.contentInventory.map((entry) => entry.path).sort() };
}

/**
 * Restores one verified backup by replacing the target data root.
 *
 * @param input Backup root, target data root, and optional staging root.
 * @returns Parsed backup manifest plus checked inventory paths.
 * @throws Error when backup verification or staged replacement fails.
 */
export async function restoreDataRootBackup(
  input: RestoreDataRootBackupInput
): Promise<VerifiedDataRootBackupManifest> {
  const backupRoot = await realpath(input.backupRoot);
  const verified = verifyDataRootBackupInventory({ backupRoot });
  const stagingInput = input.stagingRoot ?? `${input.dataRoot}.restore-staging`;
  // Resolve the parent while keeping the leaf entry that removal will act on.
  const stagingRoot = join(await resolveRestorePath(dirname(stagingInput)), basename(stagingInput));
  const previousRoot = `${input.dataRoot}.restore-previous`;
  const targetParent = dirname(resolve(input.dataRoot));
  const stagingParent = dirname(stagingRoot);

  await assertRestorePathsSeparate(input.backupRoot, backupRoot, [
    ['Restore staging root', stagingRoot],
    ['Target data root', input.dataRoot],
    ['Predecessor root', previousRoot],
  ]);
  if (readLayoutDirectory(targetParent).some((entry) => entry.name === basename(previousRoot))) {
    throw new Error(
      `Restore predecessor already exists at ${previousRoot}. Recovery is required. See Recover A Stopped Restore Hold in the NanoCore operations guide.`
    );
  }

  ensureCanonicalDirectory(targetParent, 0o777, 'retry-creation');
  if (stagingParent !== targetParent)
    ensureCanonicalDirectory(stagingParent, 0o777, 'retry-creation');
  rmSync(stagingRoot, { recursive: true, force: true });
  copyBackupTree(backupRoot, stagingRoot);

  let predecessor: 'original' | 'unacknowledged' | 'moved' = 'original';
  try {
    if (readDataRootLayoutMarker(stagingRoot).deploymentId !== verified.manifest.sourceDeploymentId)
      throw new Error('Backup manifest deployment does not match the staged Data Root.');
    await assertSupportedRestoreDatabases(
      stagingRoot,
      verified.manifest.contentInventory,
      input.dataRoot
    );
    closeWorkspaceProductReadHandles(input.dataRoot);
    syncCanonicalTree(stagingRoot);
    syncCanonicalDirectory(stagingParent);
    if (existsSync(input.dataRoot)) {
      renameSync(input.dataRoot, previousRoot);
      predecessor = 'unacknowledged';
      syncCanonicalDirectory(targetParent);
      predecessor = 'moved';
    }
    renameSync(stagingRoot, input.dataRoot);
  } catch (error) {
    // A failed rename sync leaves both trees for stopped recovery.
    if (predecessor === 'unacknowledged') throw error;
    if (predecessor === 'moved') {
      renameSync(previousRoot, input.dataRoot);
      syncCanonicalDirectory(targetParent);
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  // Either parent sync can fail after publication. Keep the predecessor until both succeed.
  syncCanonicalDirectory(targetParent);
  if (stagingParent !== targetParent) syncCanonicalDirectory(stagingParent);
  if (predecessor === 'moved') {
    rmSync(previousRoot, { recursive: true, force: true });
    syncCanonicalDirectory(targetParent);
  }
  return verified;
}

/**
 * Lists regular files under one backup root using slash-separated relative paths.
 *
 * @param root Backup root.
 * @param directory Current directory during recursion.
 * @returns Sorted relative file paths.
 */
function listRegularBackupFiles(root: string, directory: string = root): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const relativePath = relative(root, path).split(sep).join('/');
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      throw new Error(`Backup tree must not contain symlinks: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      files.push(...listRegularBackupFiles(root, path));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Backup tree contains unsupported file type: ${relativePath}`);
    }
    files.push(relativePath);
  }

  return files.sort();
}

/**
 * Rejects recursive backup destinations.
 *
 * @param dataRoot Live data root path.
 * @param backupRoot Backup destination path.
 * @throws Error when the backup destination is inside the live data root.
 */
function assertBackupRootOutsideDataRoot(dataRoot: string, backupRoot: string): void {
  assertPathOutsideRoot(backupRoot, dataRoot, 'Backup root must be outside the source data root.');
}

/**
 * Rejects paths that are equal to or nested under a root.
 *
 * @param path Candidate path.
 * @param root Root path that must not contain the candidate.
 * @param message Error message.
 * @throws Error when the candidate is equal to or inside the root.
 */
function assertPathOutsideRoot(path: string, root: string, message: string): void {
  const candidate = resolve(path);
  const parent = resolve(root);
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;

  if (candidate === parent || candidate.startsWith(prefix)) {
    throw new Error(message);
  }
}

/**
 * Refuses overlapping restore paths before restore creates, clears or moves any of them.
 *
 * Invariant: after resolving aliases, the backup and every entry its supplied path traverses lie
 * outside each restore root, and the restore roots lie outside the backup and each other. A parent
 * component applies to the directory reached after the preceding alias, as the operating system does.
 *
 * @param backupInput Backup root as supplied.
 * @param backupRoot Resolved backup root.
 * @param restoreRoots Named staging, target and predecessor roots.
 * @throws Error naming the first overlapping pair.
 */
async function assertRestorePathsSeparate(
  backupInput: string,
  backupRoot: string,
  restoreRoots: readonly (readonly [name: string, path: string])[]
): Promise<void> {
  const backupEntries = [...(await traversedPathEntries(backupInput)), backupRoot];
  const roots: [string, string][] = [];
  for (const [name, path] of restoreRoots) {
    // Compare both the entry restore acts on and, for an alias, its destination.
    const entry = join(await resolveRestorePath(dirname(path)), basename(path));
    roots.push([name, entry], [name, await resolveRestorePath(entry)]);
  }

  for (const [name, root] of roots) {
    for (const entry of backupEntries) {
      assertPathOutsideRoot(entry, root, `Backup root must be outside the ${name.toLowerCase()}.`);
    }
    assertPathOutsideRoot(root, backupRoot, `${name} must be outside the backup root.`);
    for (const [otherName, other] of roots) {
      const message = `${name} must be separate from the ${otherName.toLowerCase()}.`;
      if (otherName !== name) assertPathOutsideRoot(root, other, message);
    }
  }
}

/**
 * Lists the start directory and each entry the operating system visits to resolve a path.
 *
 * @param path Existing path as supplied.
 * @returns Entries in visit order, including the entries inside each followed alias.
 */
async function traversedPathEntries(path: string): Promise<string[]> {
  const separator = sep === '\\' ? /[\\/]/ : sep;
  const pathRoot = parse(path).root;
  let directory = pathRoot ? resolve(pathRoot) : process.cwd();
  const entries = [directory];
  const pending = path.slice(pathRoot.length).split(separator);
  let links = 0;

  for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
    const entry = join(directory, name);
    entries.push(entry);
    if (!(await lstat(entry)).isSymbolicLink()) {
      directory = entry;
      continue;
    }
    // Linux follows at most 40 links in one resolution.
    if (++links > 40) throw new Error('Backup root path follows too many aliases.');
    const target = await readlink(entry);
    const targetRoot = parse(target).root;
    if (targetRoot) directory = resolve(directory, targetRoot);
    pending.unshift(...target.slice(targetRoot.length).split(separator));
  }
  return entries;
}

/** Resolves the existing portion of a restore path before appending any missing leaf entries. */
async function resolveRestorePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    return join(await resolveRestorePath(parent), basename(path));
  }
}

/** Resolves a prospective path through its nearest existing ancestor. */
function resolvePotentialPath(path: string): string {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];

  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

/** Computes a SHA-256 content digest for one file. */
function digestFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** Computes a SHA-256 content digest for one text payload. */
function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Lists Light App directory paths relative to a data root.
 *
 * @param root Data root or backup root.
 * @returns Stable relative app directory paths.
 */
function listLightAppDirectoryPaths(root: string): string[] {
  return listRegularBackupFiles(root)
    .filter((path) => path.includes('/light-apps/') && path.endsWith('/data.sqlite'))
    .map((path) => path.slice(0, -'/data.sqlite'.length))
    .sort();
}

/**
 * Copies digest-addressed definition bytes missing from the captured tree.
 *
 * @param dataRoot Live data root.
 * @param backupRoot Captured backup root.
 */
function copyMissingLightAppDefinitions(dataRoot: string, backupRoot: string): void {
  copyMissingBackupDefinitions(dataRoot, backupRoot, listLightAppDirectoryPaths(backupRoot));
}

/**
 * Verifies each captured app database has matching definition bytes.
 *
 * @param root Backup or data-root copy.
 * @throws Error when a digest-addressed definition file is missing or mismatched.
 */
function assertLightAppDefinitionCoverage(root: string): void {
  for (const appPath of listLightAppDirectoryPaths(root)) {
    const dbPath = join(root, appPath, 'data.sqlite');
    const sqlite = new Database(dbPath, { fileMustExist: true, readonly: true });
    try {
      const row = sqlite
        .prepare('SELECT schema_digest AS schemaDigest FROM app_metadata LIMIT 1')
        .get() as { schemaDigest: string } | undefined;
      assertCapturedAppDefinition(root, appPath, row);
    } finally {
      sqlite.close();
    }
  }
}

/** Checks the same retained definition bytes for standalone verification and private restore inspection. */
function assertCapturedAppDefinition(
  root: string,
  appPath: string,
  row: { schemaDigest: string } | undefined
): void {
  if (!row?.schemaDigest?.startsWith('sha256:')) {
    throw new Error(`Captured Light App is missing schema digest: ${appPath}`);
  }
  const hex = row.schemaDigest.slice('sha256:'.length);
  const definitionPath = join(root, appPath, 'definitions', `${hex}.json`);
  if (!existsSync(definitionPath)) {
    throw new Error(`Captured Light App is missing definition bytes: ${appPath}`);
  }
  if (digestFile(definitionPath) !== row.schemaDigest) {
    throw new Error(`Captured Light App definition digest mismatch: ${appPath}`);
  }
}

/**
 * Admits restored journals and current App definitions through bounded private database-and-WAL copies.
 * Immutable App snapshots receive journal admission only; their recovery owner retains lineage checks.
 * SQLite may create WAL sidecars even on read-only opens. Existing Storage helpers copy
 * one database and its committed WAL at a time beside the unpublished candidate and
 * remove that scratch before placement. The admitted staging parent stays writable even
 * when a copied candidate preserves a read-only root mode. Verified source sizes and digests bound each copy.
 *
 * @param root Backup or staged data-root copy.
 * @param inventory Exact verified source inventory; opaque content is never opened as a scope.
 * @param targetRoot Existing target whose split owner files must have archive coverage.
 * @throws When an owned ledger is unsupported or App definition bytes are missing or mismatched.
 */
async function assertSupportedRestoreDatabases(
  root: string,
  inventory: DataRootBackupManifest['contentInventory'],
  targetRoot: string
): Promise<void> {
  const entries = new Map(inventory.map((entry) => [entry.path, entry]));
  if (!entries.has('server/db/core.sqlite'))
    throw new Error('Restore backup is missing its canonical Core database.');
  for (const owner of Object.keys(SPLIT_STORAGE_JOURNALS) as SplitStorageOwner[]) {
    const path = `server/${SPLIT_STORAGE_JOURNALS[owner]}/state.sqlite`;
    if (!entries.has(path) && (await inspectServerOwnerFile(targetRoot, owner)))
      throw new Error(`Restore backup is missing the target's existing Server owner: ${path}.`);
  }
  const targetServer = join(targetRoot, 'server');
  for (const { name: kind } of readLayoutDirectory(targetServer)) {
    if (kind !== 'services' && kind !== 'extensions') continue;
    const ownerRoot = join(targetServer, kind);
    for (const owner of readLayoutDirectory(ownerRoot)) {
      if (!owner.isDirectory()) continue;
      const hasDatabase = readLayoutDirectory(join(ownerRoot, owner.name)).some(({ name }) =>
        /^state\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)
      );
      if (!hasDatabase) continue;
      const path = `server/${kind}/${owner.name}/state.sqlite`;
      restoreDatabaseBinding(path, 'target');
      if (!entries.has(path))
        throw new Error(`Restore backup is missing the target's existing Server owner: ${path}.`);
    }
  }
  for (const { path } of inventory) {
    const basePath = path.replace(/-(?:wal|shm|journal)$/, '');
    const binding = restoreDatabaseBinding(basePath);
    if (!binding) continue;
    if (path !== basePath) {
      if (!entries.has(basePath))
        throw new Error(`Restore backup has a SQLite sidecar without its database: ${basePath}.`);
      continue;
    }
    const inspectionRoot = await createPrivateTree(dirname(root), '.ledger-admission-');
    const dbPath = join(inspectionRoot, basename(path));
    let sqlite: Database.Database | undefined;
    try {
      // SHM is disposable cache. Journal and committed WAL bytes can affect admission.
      for (const suffix of ['', '-wal', '-journal']) {
        const entry = entries.get(`${path}${suffix}`);
        if (!entry) continue;
        const source = join(root, entry.path);
        const copy = `${dbPath}${suffix}`;
        const metadata = assertCanonicalRegularFile(source);
        if (metadata.nlink !== 1 || metadata.size !== entry.bytes)
          throw new Error(`Restore database member changed: ${entry.path}.`);
        // This unpublished stage can sit below a search-only ancestor. Check the copy
        // against the sealed inventory before giving any bytes to SQLite.
        copyPortableOriginalFile(source, copy, entry.bytes);
        if (
          assertCanonicalRegularFile(copy).size !== entry.bytes ||
          digestFile(copy) !== entry.digest
        )
          throw new Error(`Restore database copy does not match the backup: ${entry.path}.`);
      }
      if ('owner' in binding) {
        verifyServerOwnerRestoreCopy(dbPath, binding.owner);
        continue;
      }
      sqlite = openSupportedScopeReadOnlySqlite(dbPath, binding.scope);
      if (binding.scope === 'core') assertCoreBaseline(sqlite);
      else assertNativeBaseline(sqlite, binding.scope);
      if (binding.scope !== 'app' || !path.endsWith('/data.sqlite')) continue;
      const appPath = dirname(path);
      const row = sqlite
        .prepare('SELECT schema_digest AS schemaDigest FROM app_metadata LIMIT 1')
        .get() as { schemaDigest: string } | undefined;
      assertCapturedAppDefinition(root, appPath, row);
    } finally {
      try {
        sqlite?.close();
      } finally {
        await removePrivateTree(inspectionRoot);
      }
    }
  }
}

/** Maps a canonical database path to the journal that owns its bytes. */
function restoreDatabaseBinding(
  path: string,
  location: 'backup' | 'target' = 'backup'
): { scope: StorageMigrationScope } | { owner: SplitStorageOwner } | undefined {
  if (path === 'server/db/core.sqlite') return { scope: 'core' };
  if (/^users\/[^/]+\/db\/user\.sqlite$/.test(path)) return { scope: 'user' };
  if (/^workspaces\/[^/]+\/db\/workspace\.sqlite$/.test(path)) return { scope: 'workspace' };
  if (
    /^workspaces\/[^/]+\/light-apps\/[^/]+\/(?:data\.sqlite|snapshots\/[^/]+\.sqlite)$/.test(path)
  )
    return { scope: 'app' };
  if (!/^server\/(?:services|extensions)\/[^/]+\/state\.sqlite$/.test(path)) return undefined;
  const owner = (Object.keys(SPLIT_STORAGE_JOURNALS) as SplitStorageOwner[]).find(
    (id) => path === `server/${SPLIT_STORAGE_JOURNALS[id]}/state.sqlite`
  );
  if (!owner) throw new Error(`Restore ${location} has an unsupported Server owner: ${path}.`);
  return { owner };
}

/** Binds recovery placement to the original ordered inventory encoding, after all writers close. */
export function workspaceRecoveryCandidateDigest(root: string): string {
  return sha256Hex(JSON.stringify(inventoryRegularFiles(root)));
}
