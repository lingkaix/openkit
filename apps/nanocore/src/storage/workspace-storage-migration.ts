import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { AgentEnvironmentPackageSnapshotRecordSchema } from '@openkit/app-api-schemas';
import {
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
  WorkspaceConfigSchema,
} from '@openkit/config-schema';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { listExportableAgentEnvironmentPackageSnapshots } from '../runtime/aep-snapshot-ledger.js';
import {
  inventoryRegularFiles,
  type RegularFileInventoryEntry,
  type VerifiedDataRootBackupManifest,
  writeColdDataRootBackupManifest,
} from './data-root-backup.js';
import {
  type CoreDb,
  openWorkspaceDbAtRoot,
  verifyAndMigrateExistingScopedDatabases,
} from './db.js';
import { readDataRootLayoutMarker, resolveDataRootPath } from './fs-layout.js';
import { rebuildExistingWorkspaceDerivedIndexes } from './index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import * as schema from './schema/index.js';
import { loadWorkspaceFileRecords, WorkspaceSystemRecordSchema } from './workspace-file-records.js';

/** Stable preflight diagnostic codes for the one-way Workspace storage migration. */
export type WorkspaceStorageMigrationDiagnosticCode =
  | 'duplicate_workspace_root'
  | 'mixed_workspace_layout'
  | 'owner_membership_missing'
  | 'unsafe_workspace_id'
  | 'unsafe_workspace_root'
  | 'workspace_database_corrupt'
  | 'workspace_owner_missing'
  | 'workspace_owner_mismatch'
  | 'workspace_registry_missing'
  | 'workspace_source_missing';

/** One safe diagnostic emitted before any migration write. */
export interface WorkspaceStorageMigrationDiagnostic {
  /** Stable machine-readable reason. */
  readonly code: WorkspaceStorageMigrationDiagnosticCode;
  /** Workspace identity when the failure can be scoped safely. */
  readonly workspaceId: string | null;
}

/** Input for the read-only Workspace storage migration preflight. */
export interface PreflightWorkspaceStorageMigrationInput {
  /** Open authoritative Core database. */
  readonly coreDb: CoreDb;
  /** Current owner-nested data root. */
  readonly dataRoot: string;
}

/** Read-only result returned before migration staging begins. */
export interface WorkspaceStorageMigrationPreflightResult {
  /** Every detected blocking diagnostic in stable scan order. */
  readonly diagnostics: WorkspaceStorageMigrationDiagnostic[];
  /** Number of authoritative Workspace registry rows inspected. */
  readonly workspaceCount: number;
}

/** Input for the one-way stopped-process Workspace storage migration. */
export interface MigrateWorkspaceStorageInput {
  /** External destination for the complete predecessor cold backup. */
  readonly backupRoot: string;
  /** Predecessor v1 data root to migrate in place. */
  readonly dataRoot: string;
  /** Optional timestamp source for deterministic tests. */
  readonly now?: () => string;
}

/** Successful result of the one-way Workspace storage migration. */
export interface WorkspaceStorageMigrationResult {
  /** Verified predecessor backup id. */
  readonly backupId: string;
  /** Successful terminal outcome. */
  readonly outcome: 'succeeded';
  /** Number of migrated Workspaces. */
  readonly workspaceCount: number;
}

/** Accepted predecessor data-root layout marker. */
interface PredecessorLayoutMarker {
  /** Marker schema version. */
  readonly schemaVersion: 1;
  /** Predecessor physical layout version. */
  readonly layoutVersion: 1;
  /** Stable deployment identity preserved through the storage cutover. */
  readonly deploymentId: string;
  /** Optional earlier deployment identity preserved unchanged. */
  readonly predecessorDeploymentId?: string;
}

/** Stable migration stages recorded as evidence. */
type WorkspaceStorageMigrationStage =
  | 'aep-snapshots'
  | 'backup'
  | 'core-schema'
  | 'marker'
  | 'preflight'
  | 'publish'
  | 'remove-predecessor'
  | 'report'
  | 'staging'
  | 'verification'
  | 'workspace-schema';

/** Verified predecessor source and its final target identity. */
interface WorkspaceMigrationSource {
  /** Absolute predecessor Workspace root. */
  readonly sourceRoot: string;
  /** Exact predecessor file inventory captured before writes. */
  readonly sourceInventory: RegularFileInventoryEntry[];
  /** Data-root-relative predecessor path. */
  readonly sourcePath: string;
  /** Data-root-relative successor path. */
  readonly targetPath: string;
  /** Canonical Workspace id. */
  readonly workspaceId: string;
}

/** One predecessor-to-successor file digest mapping. */
interface WorkspaceMigrationFileMapping {
  /** Workspace-relative file path. */
  readonly path: string;
  /** Predecessor file metadata, or null for a successor-only file. */
  readonly source: Omit<RegularFileInventoryEntry, 'path'> | null;
  /** Successor file metadata, or null for a predecessor-only file. */
  readonly target: Omit<RegularFileInventoryEntry, 'path'> | null;
}

/** One migration-only AEP snapshot content-digest rewrite. */
interface AepSnapshotDigestMapping {
  /** Canonical successor path relative to the data root. */
  readonly path: string;
  /** V1 enclosing snapshot-record content digest. */
  readonly sourceContentDigest: string;
  /** V4 enclosing snapshot-record content digest. */
  readonly targetContentDigest: string;
}

/** One Workspace entry in the evidence-only migration report. */
interface WorkspaceMigrationReportEntry {
  /** Predecessor-to-successor file mappings in stable path order. */
  readonly files: WorkspaceMigrationFileMapping[];
  /** Data-root-relative predecessor root. */
  readonly sourcePath: string;
  /** Data-root-relative successor root. */
  readonly targetPath: string;
  /** Canonical Workspace id. */
  readonly workspaceId: string;
}

/** Evidence-only report written after a verified predecessor backup exists. */
interface WorkspaceStorageMigrationReport {
  /** Deterministic V1-to-V4 AEP snapshot digest rewrites. */
  readonly aepSnapshots: AepSnapshotDigestMapping[];
  /** Verified predecessor backup identity and digest. */
  readonly backup: {
    readonly contentDigest: string;
    readonly id: string;
    readonly inventoryFileCount: number;
  };
  /** Migration completion timestamp. */
  readonly completedAt: string;
  /** Preserved deployment identity. */
  readonly deploymentId: string;
  /** Redacted failure evidence when the procedure did not complete. */
  readonly failure?: {
    readonly message: string;
    readonly name: string;
  };
  /** Terminal evidence outcome. */
  readonly outcome: 'failed' | 'succeeded';
  /** Stable record discriminator. */
  readonly recordType: 'workspace-storage-migration';
  /** Report schema version. */
  readonly schemaVersion: 1;
  /** Predecessor layout version. */
  readonly sourceLayoutVersion: 1;
  /** Migration start timestamp. */
  readonly startedAt: string;
  /** Last attempted migration stage. */
  readonly stage: WorkspaceStorageMigrationStage;
  /** Successor layout version. */
  readonly targetLayoutVersion: 2;
  /** Per-Workspace relative identities and digest mappings. */
  readonly workspaces: WorkspaceMigrationReportEntry[];
}

/** Input used to build one success or failure evidence report. */
interface CreateMigrationReportInput {
  /** Deterministic V1-to-V4 AEP snapshot digest rewrites. */
  readonly aepSnapshots: AepSnapshotDigestMapping[];
  /** Verified predecessor cold backup. */
  readonly backup: VerifiedDataRootBackupManifest;
  /** Migration completion timestamp. */
  readonly completedAt: string;
  /** Data root used to resolve successor inventories. */
  readonly dataRoot: string;
  /** Optional primary failure. */
  readonly error?: unknown;
  /** Accepted predecessor marker. */
  readonly marker: PredecessorLayoutMarker;
  /** Terminal evidence outcome. */
  readonly outcome: 'failed' | 'succeeded';
  /** Captured predecessor Workspace sources. */
  readonly sources: WorkspaceMigrationSource[];
  /** Last attempted migration stage. */
  readonly stage: WorkspaceStorageMigrationStage;
  /** Migration start timestamp. */
  readonly startedAt: string;
}

/** One authoritative Workspace registry row used during preflight. */
interface WorkspaceRegistryRow {
  /** Canonical owner user id. */
  readonly owner_user_id: string;
  /** Canonical Workspace id. */
  readonly workspace_id: string;
}

/** One discovered owner-nested Workspace root. */
interface DiscoveredWorkspaceRoot {
  /** Physical owner directory. */
  readonly ownerUserId: string;
  /** Absolute root used only for local verification. */
  readonly path: string;
  /** Whether the root itself is a symbolic link. */
  readonly symbolicLink: boolean;
  /** Workspace directory name. */
  readonly workspaceId: string;
}

/** Stable evidence report name for the single supported layout cutover. */
const WORKSPACE_STORAGE_MIGRATION_REPORT_FILE = 'workspace-storage-v1-to-v2.json';

/** Migration-owned same-filesystem root that becomes `workspaces/` through one rename. */
const WORKSPACE_STORAGE_STAGING_DIRECTORY = '.workspace-storage-v2-staging';

/**
 * Migrates one stopped v1 data root to the owner-independent v2 Workspace layout.
 *
 * @param input Data root, external cold-backup destination, and optional clock.
 * @returns Successful migration summary.
 * @throws Error when preflight, backup, staging, publication, schema migration, or verification fails.
 */
export function migrateWorkspaceStorage(
  input: MigrateWorkspaceStorageInput
): WorkspaceStorageMigrationResult {
  const now = input.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const stagingRoot = resolveDataRootPath(input.dataRoot, WORKSPACE_STORAGE_STAGING_DIRECTORY);
  const targetWorkspacesRoot = resolveDataRootPath(input.dataRoot, 'workspaces');
  const reportPath = resolveDataRootPath(
    input.dataRoot,
    'server',
    'migrations',
    WORKSPACE_STORAGE_MIGRATION_REPORT_FILE
  );
  const aepSnapshots: AepSnapshotDigestMapping[] = [];
  let backup: VerifiedDataRootBackupManifest | undefined;
  let coreDb: CoreDb | undefined;
  let marker: PredecessorLayoutMarker | undefined;
  let sources: WorkspaceMigrationSource[] = [];
  let stage: WorkspaceStorageMigrationStage = 'preflight';

  assertNanoCoreStopped(input.dataRoot);
  assertExternalBackupDestination(input.dataRoot, input.backupRoot);

  try {
    marker = readPredecessorLayoutMarker(input.dataRoot);
    const predecessorInventory = inventoryRegularFiles(input.dataRoot);

    coreDb = openPredecessorCoreDb(input.dataRoot);
    const preflight = preflightWorkspaceStorageMigration({ coreDb, dataRoot: input.dataRoot });
    if (preflight.diagnostics.length > 0) {
      const codes = [...new Set(preflight.diagnostics.map((diagnostic) => diagnostic.code))];
      throw new Error(`Workspace storage migration preflight failed: ${codes.join(', ')}.`);
    }

    sources = createMigrationSources(input.dataRoot);
    coreDb.sqlite.close();
    coreDb = undefined;

    stage = 'backup';
    const backupStartedAt = now();
    copyColdDataRoot(input.dataRoot, input.backupRoot);
    const backupCompletedAt = now();
    backup = writeColdDataRootBackupManifest({
      backupRoot: input.backupRoot,
      backupId: createBackupId(marker.deploymentId, backupStartedAt),
      sourceDeploymentId: marker.deploymentId,
      startedAt: backupStartedAt,
      completedAt: backupCompletedAt,
    });
    assertBackupMatchesPredecessor(backup, predecessorInventory);

    stage = 'staging';
    if (existsSync(stagingRoot)) {
      throw new Error('Workspace storage migration staging root already exists.');
    }
    mkdirSync(stagingRoot);
    for (const source of sources) {
      const stagedWorkspaceRoot = join(stagingRoot, source.workspaceId);
      cpSync(source.sourceRoot, stagedWorkspaceRoot, {
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        recursive: true,
      });
      const stagedInventory = inventoryRegularFiles(stagedWorkspaceRoot);
      assertInventoriesEqual(source.sourceInventory, stagedInventory, source.workspaceId);
    }

    stage = 'workspace-schema';
    for (const source of sources) {
      stage = 'workspace-schema';
      const stagedWorkspaceRoot = join(stagingRoot, source.workspaceId);
      const workspaceDb = openWorkspaceDbAtRoot({
        dataRoot: input.dataRoot,
        workspaceId: source.workspaceId,
        workspaceRoot: stagedWorkspaceRoot,
      });

      try {
        migrateStagedWorkspaceMetadata(stagedWorkspaceRoot, source.workspaceId);
        applyScopedMigrations(workspaceDb);
        stage = 'aep-snapshots';
        aepSnapshots.push(...migrateStagedAepSnapshots(stagedWorkspaceRoot, source.targetPath));
        listExportableAgentEnvironmentPackageSnapshots(workspaceDb, source.workspaceId);
      } finally {
        workspaceDb.sqlite.close();
      }

      assertWorkspaceDatabaseHealthy(stagedWorkspaceRoot, source.workspaceId);
      inventoryRegularFiles(stagedWorkspaceRoot);
    }

    stage = 'publish';
    if (existsSync(targetWorkspacesRoot)) {
      throw new Error('Published top-level Workspace root already exists.');
    }
    renameSync(stagingRoot, targetWorkspacesRoot);

    stage = 'core-schema';
    coreDb = openPredecessorCoreDb(input.dataRoot);
    applyMigrations(coreDb);
    verifyCoreWorkspaceConstraints(coreDb, sources);
    verifyPublishedWorkspaceTrees(input.dataRoot, sources);

    stage = 'remove-predecessor';
    removePredecessorWorkspaceTrees(input.dataRoot);
    assertNoPredecessorWorkspaceTrees(input.dataRoot);

    stage = 'marker';
    writeSuccessorLayoutMarker(input.dataRoot, marker);
    readDataRootLayoutMarker(input.dataRoot);
    coreDb.sqlite.close();
    coreDb = undefined;

    stage = 'verification';
    verifyAndMigrateExistingScopedDatabases(input.dataRoot);
    const rebuiltIndexes = rebuildExistingWorkspaceDerivedIndexes(input.dataRoot, { now });
    if (rebuiltIndexes.length !== sources.length) {
      throw new Error('Derived-index verification did not rebuild every migrated Workspace.');
    }
    const records = loadWorkspaceFileRecords(input.dataRoot);
    assertWorkspaceIdsEqual(
      sources.map((source) => source.workspaceId),
      records.map((record) => record.workspace.id),
      'Canonical Workspace read verification failed.'
    );
    verifyPublishedWorkspaceTrees(input.dataRoot, sources);

    stage = 'report';
    const report = createMigrationReport({
      aepSnapshots,
      backup,
      completedAt: now(),
      dataRoot: input.dataRoot,
      marker,
      outcome: 'succeeded',
      sources,
      stage,
      startedAt,
    });
    writeJsonAtomically(reportPath, report);

    return {
      backupId: backup.manifest.id,
      outcome: 'succeeded',
      workspaceCount: sources.length,
    };
  } catch (error) {
    coreDb?.sqlite.close();

    rmSync(stagingRoot, { force: true, recursive: true });
    if (backup && marker) {
      try {
        const report = createMigrationReport({
          aepSnapshots,
          backup,
          completedAt: now(),
          dataRoot: input.dataRoot,
          error,
          marker,
          outcome: 'failed',
          sources,
          stage,
          startedAt,
        });
        writeJsonAtomically(reportPath, report);
      } catch {
        // The primary migration failure remains authoritative when evidence writing also fails.
      }
    }

    throw error;
  }
}

/** Rewrites predecessor Workspace metadata into the current record and editable-config split. */
function migrateStagedWorkspaceMetadata(workspaceRoot: string, workspaceId: string): void {
  const predecessorPath = join(workspaceRoot, 'workspace.json');
  const value = JSON.parse(readFileSync(predecessorPath, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid predecessor Workspace record: ${workspaceId}.`);
  }

  const { counts: _counts, defaults, name, ...systemFields } = value as Record<string, unknown>;
  const defaultAgentId =
    typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults)
      ? ((defaults as Record<string, unknown>).defaultAgentId ?? null)
      : null;
  const record = WorkspaceSystemRecordSchema.parse(systemFields);
  const config = WorkspaceConfigSchema.parse({
    schemaVersion: 1,
    workspace: { name, defaultAgentId },
  });

  writeJsonAtomically(join(workspaceRoot, 'workspace-record.json'), record);
  writeJsonAtomically(join(workspaceRoot, 'config', 'workspace.jsonc'), config);
  rmSync(predecessorPath);
}

/**
 * Validates the complete current owner-nested layout without writing or repairing it.
 *
 * @param input Core database and current data root.
 * @returns Blocking diagnostics and the inspected registry count.
 */
export function preflightWorkspaceStorageMigration(
  input: PreflightWorkspaceStorageMigrationInput
): WorkspaceStorageMigrationPreflightResult {
  const diagnostics: WorkspaceStorageMigrationDiagnostic[] = [];
  const registryRows = input.coreDb.sqlite
    .prepare(
      `SELECT workspace_id, owner_user_id
       FROM workspace_registry
       ORDER BY workspace_id`
    )
    .all() as WorkspaceRegistryRow[];
  const registryByWorkspaceId = new Map(
    registryRows.map((row) => [row.workspace_id, row] as const)
  );
  const physicalRoots = discoverOwnerNestedWorkspaceRoots(input.dataRoot, diagnostics);
  const rootsByWorkspaceId = new Map<string, DiscoveredWorkspaceRoot[]>();

  for (const root of physicalRoots) {
    const roots = rootsByWorkspaceId.get(root.workspaceId) ?? [];
    roots.push(root);
    rootsByWorkspaceId.set(root.workspaceId, roots);
  }

  if (hasTopLevelWorkspaceRoot(input.dataRoot)) {
    diagnostics.push({ code: 'mixed_workspace_layout', workspaceId: null });
  }

  for (const [workspaceId, roots] of [...rootsByWorkspaceId].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (roots.length > 1) {
      diagnostics.push({ code: 'duplicate_workspace_root', workspaceId });
    }

    const registry = registryByWorkspaceId.get(workspaceId);
    if (!registry) {
      diagnostics.push({ code: 'workspace_registry_missing', workspaceId });
    }

    for (const root of roots) {
      if (root.symbolicLink) {
        diagnostics.push({ code: 'unsafe_workspace_root', workspaceId });
        continue;
      }
      if (!treeContainsOnlyDirectoriesAndRegularFiles(root.path)) {
        diagnostics.push({ code: 'unsafe_workspace_root', workspaceId });
        continue;
      }
      if (registry && registry.owner_user_id !== root.ownerUserId) {
        diagnostics.push({ code: 'workspace_owner_mismatch', workspaceId });
      }
      if (!workspaceDatabaseIsHealthy(join(root.path, 'db', 'workspace.sqlite'))) {
        diagnostics.push({ code: 'workspace_database_corrupt', workspaceId });
      }
    }
  }

  for (const row of registryRows) {
    if (!workspaceIdIsSafe(input.dataRoot, row.workspace_id)) {
      diagnostics.push({ code: 'unsafe_workspace_id', workspaceId: row.workspace_id });
      continue;
    }
    if (!rootsByWorkspaceId.has(row.workspace_id)) {
      diagnostics.push({ code: 'workspace_source_missing', workspaceId: row.workspace_id });
    }

    const owner = input.coreDb.sqlite
      .prepare('SELECT 1 FROM users WHERE id = ?')
      .get(row.owner_user_id);
    if (!owner) {
      diagnostics.push({ code: 'workspace_owner_missing', workspaceId: row.workspace_id });
    }

    const activeOwner = input.coreDb.sqlite
      .prepare(
        `SELECT 1
         FROM workspace_members
         WHERE workspace_id = ? AND user_id = ? AND status = 'active'`
      )
      .get(row.workspace_id, row.owner_user_id);
    if (!activeOwner) {
      diagnostics.push({ code: 'owner_membership_missing', workspaceId: row.workspace_id });
    }
  }

  return { diagnostics, workspaceCount: registryRows.length };
}

/**
 * Discovers owner-nested Workspace roots without following symbolic links.
 *
 * @param dataRoot Current data root.
 * @param diagnostics Mutable diagnostic sink for unsafe ancestor links.
 * @returns Stable physical root inventory.
 */
function discoverOwnerNestedWorkspaceRoots(
  dataRoot: string,
  diagnostics: WorkspaceStorageMigrationDiagnostic[]
): DiscoveredWorkspaceRoot[] {
  const usersRoot = join(dataRoot, 'users');
  if (!existsSync(usersRoot)) {
    return [];
  }
  const usersMetadata = lstatSync(usersRoot);
  if (usersMetadata.isSymbolicLink() || !usersMetadata.isDirectory()) {
    diagnostics.push({ code: 'unsafe_workspace_root', workspaceId: null });
    return [];
  }

  const roots: DiscoveredWorkspaceRoot[] = [];
  for (const userEntry of readdirSync(usersRoot, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const userRoot = join(usersRoot, userEntry.name);
    if (userEntry.isSymbolicLink()) {
      diagnostics.push({ code: 'unsafe_workspace_root', workspaceId: null });
      continue;
    }
    if (!userEntry.isDirectory()) {
      diagnostics.push({ code: 'unsafe_workspace_root', workspaceId: null });
      continue;
    }

    const workspacesRoot = join(userRoot, 'workspaces');
    if (!existsSync(workspacesRoot)) {
      continue;
    }
    const workspacesMetadata = lstatSync(workspacesRoot);
    if (workspacesMetadata.isSymbolicLink() || !workspacesMetadata.isDirectory()) {
      diagnostics.push({ code: 'unsafe_workspace_root', workspaceId: null });
      continue;
    }

    for (const workspaceEntry of readdirSync(workspacesRoot, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      if (!workspaceEntry.isDirectory() && !workspaceEntry.isSymbolicLink()) {
        diagnostics.push({
          code: 'unsafe_workspace_root',
          workspaceId: workspaceEntry.name,
        });
        continue;
      }
      roots.push({
        ownerUserId: userEntry.name,
        path: join(workspacesRoot, workspaceEntry.name),
        symbolicLink: workspaceEntry.isSymbolicLink(),
        workspaceId: workspaceEntry.name,
      });
    }
  }

  return roots;
}

/**
 * Checks whether any new-layout Workspace root already exists.
 *
 * @param dataRoot Current data root.
 * @returns True when the old and new layouts would be mixed.
 */
function hasTopLevelWorkspaceRoot(dataRoot: string): boolean {
  const workspacesRoot = join(dataRoot, 'workspaces');
  return existsSync(workspacesRoot);
}

/**
 * Validates a registry Workspace id through the canonical data-root path guard.
 *
 * @param dataRoot Current data root.
 * @param workspaceId Registry Workspace id.
 * @returns True when the identifier cannot escape its target root.
 */
function workspaceIdIsSafe(dataRoot: string, workspaceId: string): boolean {
  try {
    resolveDataRootPath(dataRoot, 'workspaces', workspaceId);
    return (
      workspaceId.length > 0 &&
      workspaceId !== '.' &&
      workspaceId !== '..' &&
      !workspaceId.includes('/') &&
      !workspaceId.includes('\\')
    );
  } catch {
    return false;
  }
}

/**
 * Performs a read-only SQLite integrity check for one authoritative Workspace database.
 *
 * @param path Workspace database path.
 * @returns True only for an existing database whose quick check passes.
 */
function workspaceDatabaseIsHealthy(path: string): boolean {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
    return false;
  }

  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(path, { fileMustExist: true, readonly: true });
    return sqlite.prepare('PRAGMA quick_check').pluck().get() === 'ok';
  } catch {
    return false;
  } finally {
    sqlite?.close();
  }
}

/**
 * Rejects migration while the normal NanoCore process lock exists.
 *
 * @param dataRoot Candidate predecessor data root.
 * @throws Error when NanoCore appears to be active.
 */
function assertNanoCoreStopped(dataRoot: string): void {
  const lockPath = resolveDataRootPath(dataRoot, 'server', 'runtime', 'nanocore.lock');

  if (existsSync(lockPath)) {
    throw new Error(`Refusing to migrate while NanoCore appears to be running: ${lockPath}`);
  }
}

/**
 * Rejects destructive or recursive cold-backup destinations.
 *
 * @param dataRoot Source data root.
 * @param backupRoot Caller-selected external destination.
 * @throws Error when either tree contains the other or the destination is unsafe.
 */
function assertExternalBackupDestination(dataRoot: string, backupRoot: string): void {
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
 * Resolves a path through its nearest existing ancestor without creating it.
 *
 * @param path Existing or prospective path.
 * @returns Canonical absolute path suitable for containment checks.
 */
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

/**
 * Reads and validates the only supported predecessor layout marker.
 *
 * @param dataRoot Predecessor data root.
 * @returns Valid v1 marker.
 * @throws Error when the marker is linked, malformed, or not exactly v1.
 */
function readPredecessorLayoutMarker(dataRoot: string): PredecessorLayoutMarker {
  const markerPath = resolveDataRootPath(dataRoot, 'server', 'layout.json');
  const metadata = lstatSync(markerPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Predecessor layout marker must be a regular file.');
  }

  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
  if (
    typeof marker !== 'object' ||
    marker === null ||
    !('schemaVersion' in marker) ||
    marker.schemaVersion !== 1 ||
    !('layoutVersion' in marker) ||
    marker.layoutVersion !== 1 ||
    !('deploymentId' in marker) ||
    typeof marker.deploymentId !== 'string' ||
    marker.deploymentId.length === 0 ||
    ('predecessorDeploymentId' in marker &&
      (typeof marker.predecessorDeploymentId !== 'string' ||
        marker.predecessorDeploymentId.length === 0))
  ) {
    throw new Error('Workspace storage migration requires a supported v1 layout marker.');
  }

  return marker as PredecessorLayoutMarker;
}

/**
 * Opens the v1 Core database without invoking the v2 layout initializer.
 *
 * @param dataRoot Predecessor data root.
 * @returns Open raw and Drizzle Core handles.
 * @throws Error when the Core database is missing, linked, or corrupt.
 */
function openPredecessorCoreDb(dataRoot: string): CoreDb {
  const path = resolveDataRootPath(dataRoot, 'server', 'db', 'core.sqlite');
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Predecessor Core database must be a regular file.');
  }

  const sqlite = new Database(path, { fileMustExist: true });
  sqlite.pragma('foreign_keys = ON');

  if (sqlite.prepare('PRAGMA quick_check').pluck().get() !== 'ok') {
    sqlite.close();
    throw new Error('Predecessor Core database failed SQLite integrity validation.');
  }

  return { scope: 'core', sqlite, db: drizzle(sqlite, { schema }), dataRoot };
}

/**
 * Captures stable source identities and exact file inventories after preflight.
 *
 * @param dataRoot Verified predecessor data root.
 * @returns Stable Workspace migration sources.
 */
function createMigrationSources(dataRoot: string): WorkspaceMigrationSource[] {
  const diagnostics: WorkspaceStorageMigrationDiagnostic[] = [];
  const roots = discoverOwnerNestedWorkspaceRoots(dataRoot, diagnostics);
  if (diagnostics.length > 0) {
    throw new Error('Workspace source layout changed after preflight.');
  }

  return roots
    .map((root) => ({
      sourceRoot: root.path,
      sourceInventory: inventoryRegularFiles(root.path),
      sourcePath: toReportPath(dataRoot, root.path),
      targetPath: toReportPath(
        dataRoot,
        resolveDataRootPath(dataRoot, 'workspaces', root.workspaceId)
      ),
      workspaceId: root.workspaceId,
    }))
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}

/**
 * Copies the stopped predecessor data root to an external destination.
 *
 * @param dataRoot Verified stopped source root.
 * @param backupRoot External destination to replace.
 */
function copyColdDataRoot(dataRoot: string, backupRoot: string): void {
  mkdirSync(dirname(backupRoot), { recursive: true });
  cpSync(dataRoot, backupRoot, {
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    recursive: true,
  });
}

/**
 * Creates a deterministic backup id from predecessor lineage and capture time.
 *
 * @param deploymentId Preserved deployment identity.
 * @param startedAt Backup start timestamp.
 * @returns Stable backup id.
 */
function createBackupId(deploymentId: string, startedAt: string): string {
  const suffix = createHash('sha256')
    .update(`${deploymentId}\0${startedAt}`)
    .digest('hex')
    .slice(0, 24);
  return `backup_workspace_storage_${suffix}`;
}

/**
 * Verifies that the external manifest exactly matches the captured predecessor data root.
 *
 * @param backup Verified external cold backup.
 * @param predecessorInventory Captured complete predecessor file inventory.
 * @throws Error when any predecessor path, size, or digest differs from the backup.
 */
function assertBackupMatchesPredecessor(
  backup: VerifiedDataRootBackupManifest,
  predecessorInventory: readonly RegularFileInventoryEntry[]
): void {
  const backupInventory = backup.manifest.contentInventory.map((file) => ({
    bytes: file.bytes,
    digest: file.digest,
    path: file.path,
  }));

  if (JSON.stringify(predecessorInventory) !== JSON.stringify(backupInventory)) {
    throw new Error('Verified backup does not match the complete predecessor inventory.');
  }
}

/**
 * Transforms migration-only V1 AEP snapshot records under one staged Workspace.
 *
 * @param workspaceRoot Staged Workspace root.
 * @param targetWorkspacePath Canonical successor Workspace path relative to the data root.
 * @returns Stable predecessor-to-successor snapshot digest mappings.
 * @throws Error when a snapshot path or V1 identity cannot become an exact V2 record.
 */
function migrateStagedAepSnapshots(
  workspaceRoot: string,
  targetWorkspacePath: string
): AepSnapshotDigestMapping[] {
  const sessionsRoot = join(workspaceRoot, 'runtime', 'agent-sessions');
  if (!existsSync(sessionsRoot)) {
    return [];
  }

  const mappings: AepSnapshotDigestMapping[] = [];
  for (const sessionEntry of readdirSync(sessionsRoot, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name)
  )) {
    if (sessionEntry.isSymbolicLink()) {
      throw new Error('AEP migration session path must not be symbolic.');
    }
    if (!sessionEntry.isDirectory()) {
      continue;
    }

    const snapshotsRoot = join(sessionsRoot, sessionEntry.name, 'aep-snapshots');
    if (!existsSync(snapshotsRoot)) {
      continue;
    }
    const snapshotsMetadata = lstatSync(snapshotsRoot);
    if (snapshotsMetadata.isSymbolicLink() || !snapshotsMetadata.isDirectory()) {
      throw new Error('AEP migration snapshot root must be a real directory.');
    }

    for (const snapshotEntry of readdirSync(snapshotsRoot, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      if (snapshotEntry.isSymbolicLink()) {
        throw new Error('AEP migration snapshot path must not be symbolic.');
      }
      if (!snapshotEntry.isFile() || !snapshotEntry.name.endsWith('.json')) {
        continue;
      }

      const path = join(snapshotsRoot, snapshotEntry.name);
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const snapshot =
        typeof value === 'object' && value !== null && 'snapshot' in value
          ? value.snapshot
          : undefined;
      const schemaVersion =
        typeof snapshot === 'object' && snapshot !== null && 'schemaVersion' in snapshot
          ? snapshot.schemaVersion
          : undefined;

      if (schemaVersion === 4) {
        continue;
      }
      if (schemaVersion !== 1) {
        throw new Error('AEP migration encountered an unsupported snapshot schema version.');
      }

      mappings.push(
        migrateLegacyAepSnapshotRecord(
          path,
          `${targetWorkspacePath}/${toReportPath(workspaceRoot, path)}`,
          value
        )
      );
    }
  }

  return mappings;
}

/**
 * Rewrites one V1 AEP snapshot record into the exact redacted V4 schema.
 *
 * @param path Staged snapshot record path.
 * @param reportPath Canonical successor path relative to the data root.
 * @param value Parsed V1 snapshot record.
 * @returns Predecessor and successor record-content digests.
 * @throws Error when V1 lineage, identity, digest, or final V4 validation fails.
 */
function migrateLegacyAepSnapshotRecord(
  path: string,
  reportPath: string,
  value: unknown
): AepSnapshotDigestMapping {
  const record = AgentEnvironmentPackageSnapshotRecordSchema.parse(value);
  const legacySnapshot = record.snapshot as Record<string, unknown>;
  const { providers: _retiredProviders, ...successorPackage } = legacySnapshot;
  const legacyScope = legacySnapshot.scope;
  if (
    legacySnapshot.schemaVersion !== 1 ||
    typeof legacyScope !== 'object' ||
    legacyScope === null ||
    Array.isArray(legacyScope)
  ) {
    throw new Error('AEP migration requires one valid V1 scope object.');
  }

  const sourceContentDigest = digestJson(legacySnapshot);
  if (record.contentDigest !== sourceContentDigest) {
    throw new Error('AEP migration V1 snapshot content digest does not match its record.');
  }

  const successorScope: Record<string, unknown> = {
    ...(legacyScope as Record<string, unknown>),
    triggerActor: legacyAepTriggerActor(legacyScope as Record<string, unknown>),
  };
  delete successorScope.userId;
  delete successorScope.automationId;
  delete successorScope.organizationId;

  const legacyRuntime = legacySnapshot.runtime as Record<string, unknown>;
  const legacyImage = legacyRuntime.image as Record<string, unknown>;
  const legacyControl = legacySnapshot.control as Record<string, unknown>;
  const legacyAdapter = legacyControl.adapter as Record<string, unknown>;
  const successorAdapter = { ...legacyAdapter };
  delete successorAdapter.targetTransport;
  const successorControl: Record<string, unknown> = {
    ...legacyControl,
    adapter: successorAdapter,
    bindings: {
      capabilities: {
        pathPrefix: '/capabilities/',
        tokenRef: 'runtime://openkit/capability-token',
      },
      inference: {
        pathPrefix: '/inference/',
        tokenRef: 'runtime://openkit/inference-token',
      },
      workerControl: {
        pathPrefix: '/worker-control/',
        tokenRef: 'runtime://openkit/worker-control-token',
      },
    },
    mode: 'sandbox-integration',
  };
  delete successorControl.endpoint;
  delete successorControl.auth;

  const snapshot = AgentEnvironmentPackageSchema.parse({
    ...successorPackage,
    control: successorControl,
    runtime: {
      ...legacyRuntime,
      image:
        legacyImage.kind === 'reference'
          ? legacyImage
          : {
              kind: 'reference',
              pullPolicy: legacyImage.pullPolicy,
              ref: legacyImage.ref,
            },
    },
    schemaVersion: 4,
    scope: successorScope,
  });
  const redactedSnapshot = AgentEnvironmentPackageSchema.parse(
    redactAgentEnvironmentPackageSnapshot(snapshot)
  );
  if (JSON.stringify(snapshot) !== JSON.stringify(redactedSnapshot)) {
    throw new Error('AEP migration V1 snapshot is not a redacted durable V4 record.');
  }

  const targetContentDigest = digestJson(snapshot);
  const successorRecord = AgentEnvironmentPackageSnapshotRecordSchema.parse({
    ...record,
    contentDigest: targetContentDigest,
    snapshot,
  });
  writeJsonAtomically(path, successorRecord);

  return { path: reportPath, sourceContentDigest, targetContentDigest };
}

/**
 * Maps legacy AEP identity fields to one exact V4 trigger actor.
 *
 * @param scope Parsed V1 scope object.
 * @returns Deterministic V4 trigger actor.
 * @throws Error when legacy identity is ambiguous, malformed, or absent.
 */
function legacyAepTriggerActor(scope: Record<string, unknown>):
  | { readonly id: string; readonly kind: 'user' }
  | {
      readonly id: string;
      readonly kind: 'automation';
      readonly responsibleUserId: string | null;
    } {
  if ('triggerActor' in scope) {
    throw new Error('AEP migration V1 scope must not contain triggerActor.');
  }
  for (const field of ['userId', 'automationId', 'organizationId'] as const) {
    const value = scope[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== 'string' || value.length === 0)
    ) {
      throw new Error(`AEP migration V1 scope contains an invalid ${field}.`);
    }
  }

  const automationId = scope.automationId;
  const userId = scope.userId;
  if (typeof automationId === 'string') {
    return {
      kind: 'automation',
      id: automationId,
      responsibleUserId: typeof userId === 'string' ? userId : null,
    };
  }
  if (typeof userId === 'string') {
    return { kind: 'user', id: userId };
  }

  throw new Error('AEP migration V1 scope has no supported triggering identity.');
}

/**
 * Hashes one parsed JSON value using the durable AEP snapshot digest format.
 *
 * @param value Parsed JSON value.
 * @returns Lowercase unprefixed SHA-256 digest.
 */
function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Checks a tree structurally without leaking path details into preflight diagnostics.
 *
 * @param root Workspace root.
 * @returns True when the tree can be inventoried safely.
 */
function treeContainsOnlyDirectoriesAndRegularFiles(root: string): boolean {
  try {
    inventoryRegularFiles(root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Requires byte-for-byte equality between source and staged inventories.
 *
 * @param source Captured predecessor inventory.
 * @param staged Copied staging inventory.
 * @param workspaceId Workspace identity used only to scope the error.
 * @throws Error when any path, size, or digest differs.
 */
function assertInventoriesEqual(
  source: readonly RegularFileInventoryEntry[],
  staged: readonly RegularFileInventoryEntry[],
  workspaceId: string
): void {
  if (JSON.stringify(source) !== JSON.stringify(staged)) {
    throw new Error(`Staged Workspace inventory mismatch for ${workspaceId}.`);
  }
}

/**
 * Requires one staged or published Workspace database to pass SQLite quick-check.
 *
 * @param workspaceRoot Canonical Workspace root.
 * @param workspaceId Workspace identity used only to scope the error.
 * @throws Error when the authoritative database is missing or corrupt.
 */
function assertWorkspaceDatabaseHealthy(workspaceRoot: string, workspaceId: string): void {
  if (!workspaceDatabaseIsHealthy(join(workspaceRoot, 'db', 'workspace.sqlite'))) {
    throw new Error(`Workspace database integrity validation failed for ${workspaceId}.`);
  }
}

/**
 * Verifies Core integrity, foreign keys, owner membership, and registry identity.
 *
 * @param coreDb Migrated Core database.
 * @param sources Verified Workspace sources.
 * @throws Error when the migrated Core invariants do not hold.
 */
function verifyCoreWorkspaceConstraints(
  coreDb: CoreDb,
  sources: readonly WorkspaceMigrationSource[]
): void {
  if (coreDb.sqlite.prepare('PRAGMA quick_check').pluck().get() !== 'ok') {
    throw new Error('Migrated Core database failed SQLite integrity validation.');
  }
  if ((coreDb.sqlite.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new Error('Migrated Core database failed foreign-key validation.');
  }

  const missingOwnerMemberships = coreDb.sqlite
    .prepare(
      `SELECT registry.workspace_id
       FROM workspace_registry AS registry
       LEFT JOIN workspace_members AS member
         ON member.workspace_id = registry.workspace_id
        AND member.user_id = registry.owner_user_id
        AND member.status = 'active'
        AND member.access_level = 'editor'
       WHERE member.user_id IS NULL
       ORDER BY registry.workspace_id`
    )
    .all();
  if (missingOwnerMemberships.length > 0) {
    throw new Error('Migrated Core database is missing an active editor owner membership.');
  }

  const registryIds = (
    coreDb.sqlite
      .prepare('SELECT workspace_id FROM workspace_registry ORDER BY workspace_id')
      .all() as Array<{ workspace_id: string }>
  ).map((row) => row.workspace_id);
  assertWorkspaceIdsEqual(
    sources.map((source) => source.workspaceId),
    registryIds,
    'Migrated Core Workspace registry does not match the published source set.'
  );
}

/**
 * Verifies the complete published root and every authoritative Workspace database.
 *
 * @param dataRoot Migrating or accepted data root.
 * @param sources Expected Workspace sources.
 * @throws Error when the target root is linked, incomplete, extra, or corrupt.
 */
function verifyPublishedWorkspaceTrees(
  dataRoot: string,
  sources: readonly WorkspaceMigrationSource[]
): void {
  const workspacesRoot = resolveDataRootPath(dataRoot, 'workspaces');
  inventoryRegularFiles(workspacesRoot);
  const publishedIds = readdirSync(workspacesRoot, { withFileTypes: true }).map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Published Workspace root contains an unsafe entry.');
    }
    return entry.name;
  });

  assertWorkspaceIdsEqual(
    sources.map((source) => source.workspaceId),
    publishedIds,
    'Published Workspace identities do not match the predecessor registry.'
  );
  for (const source of sources) {
    assertWorkspaceDatabaseHealthy(join(workspacesRoot, source.workspaceId), source.workspaceId);
  }
}

/**
 * Compares two Workspace id sets in stable order.
 *
 * @param expected Expected ids.
 * @param actual Actual ids.
 * @param message Failure message.
 * @throws Error when the sets differ.
 */
function assertWorkspaceIdsEqual(
  expected: readonly string[],
  actual: readonly string[],
  message: string
): void {
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
    throw new Error(message);
  }
}

/**
 * Removes every verified predecessor owner-nested Workspace container.
 *
 * @param dataRoot Migrating data root.
 */
function removePredecessorWorkspaceTrees(dataRoot: string): void {
  const usersRoot = resolveDataRootPath(dataRoot, 'users');
  if (!existsSync(usersRoot)) {
    return;
  }

  for (const userEntry of readdirSync(usersRoot, { withFileTypes: true })) {
    if (!userEntry.isDirectory() || userEntry.isSymbolicLink()) {
      continue;
    }
    rmSync(join(usersRoot, userEntry.name, 'workspaces'), { force: true, recursive: true });
  }
}

/**
 * Confirms that no owner-nested Workspace container survived cleanup.
 *
 * @param dataRoot Migrating data root.
 * @throws Error when any predecessor container remains.
 */
function assertNoPredecessorWorkspaceTrees(dataRoot: string): void {
  const usersRoot = resolveDataRootPath(dataRoot, 'users');
  if (!existsSync(usersRoot)) {
    return;
  }

  for (const userEntry of readdirSync(usersRoot, { withFileTypes: true })) {
    if (userEntry.isDirectory() && existsSync(join(usersRoot, userEntry.name, 'workspaces'))) {
      throw new Error('Predecessor owner-nested Workspace tree remains after cleanup.');
    }
  }
}

/**
 * Atomically advances the layout marker while preserving deployment lineage.
 *
 * @param dataRoot Migrating data root.
 * @param predecessor Accepted predecessor marker.
 */
function writeSuccessorLayoutMarker(dataRoot: string, predecessor: PredecessorLayoutMarker): void {
  const markerPath = resolveDataRootPath(dataRoot, 'server', 'layout.json');
  writeJsonAtomically(markerPath, {
    schemaVersion: 1,
    layoutVersion: 2,
    deploymentId: predecessor.deploymentId,
    ...(predecessor.predecessorDeploymentId
      ? { predecessorDeploymentId: predecessor.predecessorDeploymentId }
      : {}),
  });
}

/**
 * Builds one evidence-only migration report from captured and current inventories.
 *
 * @param input Report lineage, outcome, sources, and optional failure.
 * @returns Stable report payload.
 */
function createMigrationReport(input: CreateMigrationReportInput): WorkspaceStorageMigrationReport {
  const workspaces = input.sources.map((source) => {
    const targetRoot = resolveDataRootPath(input.dataRoot, 'workspaces', source.workspaceId);
    const targetInventory = existsSync(targetRoot) ? inventoryRegularFiles(targetRoot) : [];

    return {
      files: mapWorkspaceInventories(source.sourceInventory, targetInventory),
      sourcePath: source.sourcePath,
      targetPath: source.targetPath,
      workspaceId: source.workspaceId,
    };
  });

  return {
    schemaVersion: 1,
    recordType: 'workspace-storage-migration',
    aepSnapshots: [...input.aepSnapshots],
    outcome: input.outcome,
    stage: input.stage,
    sourceLayoutVersion: 1,
    targetLayoutVersion: 2,
    deploymentId: input.marker.deploymentId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    backup: {
      id: input.backup.manifest.id,
      contentDigest: input.backup.manifest.contentDigest,
      inventoryFileCount: input.backup.checkedFiles.length,
    },
    workspaces,
    ...(input.error === undefined
      ? {}
      : {
          failure: {
            name: input.error instanceof Error ? input.error.name : 'Error',
            message: redactFailureMessage(input.error, input.dataRoot),
          },
        }),
  };
}

/**
 * Maps predecessor and successor file inventories by relative path.
 *
 * @param source Predecessor file inventory.
 * @param target Successor file inventory.
 * @returns Stable union mapping with nullable sides.
 */
function mapWorkspaceInventories(
  source: readonly RegularFileInventoryEntry[],
  target: readonly RegularFileInventoryEntry[]
): WorkspaceMigrationFileMapping[] {
  const sourceByPath = new Map(source.map((file) => [file.path, file] as const));
  const targetByPath = new Map(target.map((file) => [file.path, file] as const));
  const paths = [...new Set([...sourceByPath.keys(), ...targetByPath.keys()])].sort();

  return paths.map((path) => {
    const sourceFile = sourceByPath.get(path);
    const targetFile = targetByPath.get(path);
    return {
      path,
      source: sourceFile ? { bytes: sourceFile.bytes, digest: sourceFile.digest } : null,
      target: targetFile ? { bytes: targetFile.bytes, digest: targetFile.digest } : null,
    };
  });
}

/**
 * Redacts the absolute data-root path from failure evidence.
 *
 * @param error Primary migration failure.
 * @param dataRoot Data root whose absolute path must not enter the report.
 * @returns Redacted failure message.
 */
function redactFailureMessage(error: unknown, dataRoot: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(resolve(dataRoot), '<DATA_ROOT>').replaceAll(dataRoot, '<DATA_ROOT>');
}

/**
 * Writes one JSON document through a same-directory temporary file and rename.
 *
 * @param path Final JSON path.
 * @param value JSON-serializable value.
 */
function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * Returns one slash-separated path relative to a known root.
 *
 * @param root Owning root.
 * @param path Descendant path.
 * @returns Stable relative path.
 */
function toReportPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}
