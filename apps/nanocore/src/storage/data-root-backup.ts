import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  DATA_ROOT_BACKUP_FORMAT_VERSION,
  type DataRootBackupManifest,
  parseDataRootBackupManifest,
} from '@openkit/config-schema';
import Database from 'better-sqlite3';

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
 * Writes a cold backup manifest for an already copied data root and verifies the result.
 *
 * @param input Backup metadata and root to inventory.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when the written manifest does not verify.
 */
export function writeColdDataRootBackupManifest(
  input: WriteColdDataRootBackupManifestInput
): VerifiedDataRootBackupManifest {
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
 * Copies a live data root, snapshots SQLite files via SQLite backup, and writes a hot backup manifest.
 *
 * @param input Live data root and backup destination.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when copy, SQLite backup, or manifest verification fails.
 */
export async function writeHotDataRootBackup(
  input: WriteHotDataRootBackupInput
): Promise<VerifiedDataRootBackupManifest> {
  assertBackupRootOutsideDataRoot(input.dataRoot, input.backupRoot);
  rmSync(input.backupRoot, { recursive: true, force: true });
  mkdirSync(dirname(input.backupRoot), { recursive: true });
  cpSync(input.dataRoot, input.backupRoot, { recursive: true, force: true });

  for (const path of listRegularBackupFiles(input.dataRoot).filter((path) =>
    path.endsWith('.sqlite')
  )) {
    const sourceDb = new Database(join(input.dataRoot, path), {
      fileMustExist: true,
      readonly: true,
    });

    try {
      await sourceDb.backup(join(input.backupRoot, path));
    } finally {
      sourceDb.close();
    }
  }

  return writeDataRootBackupManifest({
    backupRoot: input.backupRoot,
    backupId: input.backupId,
    sourceDeploymentId: input.sourceDeploymentId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    backupMode: 'hot',
    consistency: 'crash-consistent',
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
 * @throws Error when the written manifest does not verify.
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
  cpSync(input.backupRoot, stagingRoot, { recursive: true, force: true });

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
