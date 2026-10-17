import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  DATA_ROOT_BACKUP_FORMAT_VERSION,
  type DataRootBackupManifest,
  parseDataRootBackupManifest,
} from '@openkit/config-schema';
import { DataRootBackupIdSchema, DeploymentIdSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { writeFileAtomic } from './workspace-file-records.js';

/** File name for the data-root backup manifest. */
export const DATA_ROOT_BACKUP_MANIFEST_FILE = 'openkit-data-root-backup.json';

/** Destination directories stay owner-only until their source mode is restored. */
const OWNER_ONLY_DIRECTORY_MODE = 0o700;

/** Independently running local processes that can mutate retained Data Root bytes. */
const independentWriters = new Set<{ path: string }>();

/** Refuses capture before changing backup bytes when Core cannot pause a local writer. */
export class DataRootBackupBusyError extends Error {
  /** Creates the safe operator retry instruction without including a local path. */
  constructor() {
    super('Data-root backup requires idle local MCP servers.');
    this.name = 'DataRootBackupBusyError';
  }
}

/** Keeps backup unavailable until an independently running retained-data writer is proved stopped. */
export function registerDataRootBackupWriter(path: string): () => void {
  const writer = { path: resolve(path) };
  independentWriters.add(writer);
  return () => {
    independentWriters.delete(writer);
  };
}

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
  /** Timestamp captured after the paused snapshot finishes. */
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
    .sort((left, right) => left.path.localeCompare(right.path));
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
 * @throws Error when the copy fails.
 */
export function copyColdDataRoot(input: CopyColdDataRootInput): void {
  const omittedLock = input.omitActiveDataRootLock
    ? resolve(input.dataRoot, 'server', 'runtime', 'nanocore.lock')
    : null;

  mkdirSync(dirname(input.backupRoot), { recursive: true });
  copyDataRootTree(input.dataRoot, input.backupRoot, {
    errorOnExist: true,
    filter: (source) => resolve(source) !== omittedLock,
    preserveTimestamps: true,
  });
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

  if (JSON.stringify(predecessorInventory) !== JSON.stringify(backupInventory)) {
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
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when an identifier is invalid or the written manifest does not verify.
 */
export function writeColdDataRootBackupManifest(
  input: WriteColdDataRootBackupManifestInput
): VerifiedDataRootBackupManifest {
  DataRootBackupIdSchema.parse(input.backupId);
  DeploymentIdSchema.parse(input.sourceDeploymentId);
  return writeDataRootBackupManifest({
    backupRoot: input.backupRoot,
    backupId: input.backupId,
    sourceDeploymentId: input.sourceDeploymentId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    backupMode: 'cold',
    consistency: 'clean',
  });
}

/**
 * Captures one consistent Data Root while the single Core writer cannot run.
 *
 * SQLite files and their WALs are copied together without yielding to another Core mutation. Independently writable MCP data requires an idle local process. Disposable staging and derived indexes have no retained authority to capture.
 *
 * @param input Live data root and backup destination.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when a writer is busy, an identifier is invalid, or capture fails.
 */
export async function writeHotDataRootBackup(
  input: WriteHotDataRootBackupInput
): Promise<VerifiedDataRootBackupManifest> {
  DataRootBackupIdSchema.parse(input.backupId);
  DeploymentIdSchema.parse(input.sourceDeploymentId);
  assertBackupRootOutsideDataRoot(input.dataRoot, input.backupRoot);
  const root = resolve(input.dataRoot);
  if (
    [...independentWriters].some(({ path }) => path === root || path.startsWith(`${root}${sep}`))
  ) {
    throw new DataRootBackupBusyError();
  }

  // Do not add an await here: it would allow a newer database state than its files.
  copyDataRootTree(input.dataRoot, input.backupRoot, {
    filter: (path) => {
      const name = relative(root, path).split(sep).join('/');
      return (
        !/^(?:(?:server|(?:users|workspaces)\/[^/]+)\/)?indexes(?:\/|$)/.test(name) &&
        !/^workspaces\/\.staging(?:\/|$)/.test(name)
      );
    },
  });
  // Finish recovery of the copied WALs before inventorying them. Only the captured databases change; immutable recovery snapshots keep their original exact bytes.
  for (const path of listRegularBackupFiles(input.backupRoot).filter(
    (path) =>
      path.endsWith('.sqlite') &&
      !/^workspaces\/[^/]+\/light-apps\/[^/]+\/snapshots\/[^/]+\.sqlite$/.test(path)
  )) {
    const captured = new Database(join(input.backupRoot, path), { fileMustExist: true });
    try {
      captured.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      captured.close();
    }
  }
  assertLightAppDefinitionCoverage(input.backupRoot);

  return writeDataRootBackupManifest({
    backupRoot: input.backupRoot,
    backupId: input.backupId,
    sourceDeploymentId: input.sourceDeploymentId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    backupMode: 'hot',
    consistency: 'clean',
  });
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
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when an identifier is invalid or the written manifest does not verify.
 */
function writeDataRootBackupManifest(
  input: WriteDataRootBackupManifestInput
): VerifiedDataRootBackupManifest {
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

  writeJson(join(input.backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE), manifest);
  return verifyDataRootBackupManifest({ backupRoot: input.backupRoot });
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
  const manifest = parseDataRootBackupManifest(
    JSON.parse(readFileSync(join(input.backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE), 'utf8')),
    { supportedFeatures: input.supportedFeatures ?? [] }
  );
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
  assertLightAppDefinitionCoverage(input.backupRoot);

  return { manifest, checkedFiles: manifest.contentInventory.map((entry) => entry.path).sort() };
}

/**
 * Restores one verified backup by replacing the target data root.
 *
 * @param input Backup root, target data root, and optional staging root.
 * @returns Parsed backup manifest plus checked inventory paths.
 * @throws Error when backup verification or staged replacement fails.
 */
export function restoreDataRootBackup(
  input: RestoreDataRootBackupInput
): VerifiedDataRootBackupManifest {
  const verified = verifyDataRootBackupManifest({ backupRoot: input.backupRoot });
  const stagingRoot = input.stagingRoot ?? `${input.dataRoot}.restore-staging`;
  const previousRoot = `${input.dataRoot}.restore-previous`;

  assertPathOutsideRoot(
    input.backupRoot,
    input.dataRoot,
    'Backup root must be outside the target data root.'
  );
  assertPathOutsideRoot(
    input.dataRoot,
    input.backupRoot,
    'Target data root must be outside the backup root.'
  );
  assertPathOutsideRoot(
    stagingRoot,
    input.backupRoot,
    'Restore staging root must be outside the backup root.'
  );
  assertPathOutsideRoot(
    stagingRoot,
    input.dataRoot,
    'Restore staging root must be outside the target data root.'
  );

  rmSync(stagingRoot, { recursive: true, force: true });
  rmSync(previousRoot, { recursive: true, force: true });
  mkdirSync(dirname(stagingRoot), { recursive: true });
  copyDataRootTree(input.backupRoot, stagingRoot);

  try {
    if (existsSync(input.dataRoot)) {
      renameSync(input.dataRoot, previousRoot);
    }
    renameSync(stagingRoot, input.dataRoot);
    rmSync(previousRoot, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(input.dataRoot) && existsSync(previousRoot)) {
      renameSync(previousRoot, input.dataRoot);
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return verified;
}

/**
 * Copies one data-root tree through `cpSync`, keeping destination directories owner-only
 * until native copy finishes. Node recursive copy drops directory modes under umask 022;
 * creating directories as 0700 also keeps a 0555 source directory writable during copy.
 *
 * @param sourceRoot Source data-root or backup tree.
 * @param destinationRoot Destination tree root.
 * @param options Optional existence check, path filter, and timestamp preservation.
 * @throws Error when the source is unsafe, the destination exists with `errorOnExist`, or a node is unsupported.
 */
function copyDataRootTree(
  sourceRoot: string,
  destinationRoot: string,
  options: {
    errorOnExist?: boolean;
    filter?: (source: string) => boolean;
    preserveTimestamps?: boolean;
  } = {}
): void {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  const rootStat = lstatSync(source);

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Copy source must be a real directory: ${source}`);
  }
  if (existsSync(destination)) {
    if (options.errorOnExist) {
      throw new Error('Copy destination must not already exist.');
    }
    rmSync(destination, { recursive: true, force: true });
  }

  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination, { mode: OWNER_ONLY_DIRECTORY_MODE });
  chmodSync(destination, OWNER_ONLY_DIRECTORY_MODE);

  const directoryStats = [{ path: destination, stat: rootStat }];
  cpSync(source, destination, {
    filter: (src, dest) => {
      const stat = lstatSync(src);
      const relativePath = relative(source, src).split(sep).join('/');

      if (stat.isSymbolicLink()) {
        throw new Error(`Backup tree must not contain symlinks: ${relativePath}`);
      }
      if (options.filter && !options.filter(src)) return false;
      if (stat.isDirectory()) {
        if (resolve(src) !== source) {
          mkdirSync(dest, { mode: OWNER_ONLY_DIRECTORY_MODE });
          chmodSync(dest, OWNER_ONLY_DIRECTORY_MODE);
          directoryStats.push({ path: dest, stat });
        }
        return true;
      }
      if (!stat.isFile()) {
        throw new Error(`Backup tree contains unsupported file type: ${relativePath}`);
      }
      return true;
    },
    force: true,
    preserveTimestamps: options.preserveTimestamps === true,
    recursive: true,
  });

  for (const entry of directoryStats.reverse()) {
    chmodSync(entry.path, entry.stat.mode & 0o7777);
    if (options.preserveTimestamps) {
      utimesSync(entry.path, entry.stat.atime, entry.stat.mtime);
    }
  }
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

  if (candidate === parent || candidate.startsWith(`${parent}${sep}`)) {
    throw new Error(message);
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

/** Writes one JSON file with a trailing newline. */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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
    } finally {
      sqlite.close();
    }
  }
}
