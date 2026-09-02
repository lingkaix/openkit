import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createZstdCompress } from 'node:zlib';

import {
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunRequestSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportRequestSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { parseWorkspaceDataSourceCatalog } from '@openkit/config-schema';
import type { Context, Hono } from 'hono';

import {
  importResolvedAgentSetups,
  listExportableResolvedAgentSetups,
} from '../agents/setup-ledger.js';
import { asApiError, asInvalidRequestError } from '../api-errors.js';
import { listExportableArtifactReviews } from '../artifact-reviews.js';
import {
  importWorkspaceAuditEvents,
  listWorkspaceAuditEvents,
  recordWorkspaceAuditEvent,
} from '../audit-events.js';
import type { AuthVariables } from '../auth/middleware.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  importWorkspaceCapabilityUsageLedger,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { createWorkerContextPackageAuthorityReader } from '../context/worker-context-authorities.js';
import {
  parseWorkerContextPackageTrace,
  verifyPortableWorkerContextPackageTrace,
} from '../context/worker-context-package.js';
import {
  importWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
} from '../evidence-bundles.js';
import type { FsStore, ImportWorkspaceStage } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import {
  importWorkspacePermissionDecisions,
  listExportableWorkspacePermissionDecisions,
} from '../policy/permission-decisions.js';
import {
  importAgentEnvironmentPackageSnapshots,
  listExportableAgentEnvironmentPackageSnapshots,
} from '../runtime/aep-snapshot-ledger.js';
import {
  importWorkspaceGitPushRecords,
  listExportableGitPushRecords,
} from '../runtime/git-push-records.js';
import {
  importGoalReviewRecords,
  listExportableGoalReviewRecords,
} from '../runtime/goal-review-records.js';
import {
  importGoalPlanRecords,
  importGoalRecords,
  importGoalTasks,
  listExportableGoalPlanRecords,
  listExportableGoalRecords,
  listExportableGoalTasks,
} from '../runtime/goal-store.js';
import {
  importGoalVerificationRecords,
  listExportableGoalVerificationRecords,
} from '../runtime/goal-verification-records.js';
import {
  importMcpToolSchemaSnapshots,
  listExportableMcpToolSchemaSnapshots,
} from '../runtime/mcp-tool-schema-snapshots.js';
import {
  importWorkspaceRuntimeEvidence,
  listWorkspaceRuntimeEvidence,
} from '../runtime/runtime-evidence.js';
import {
  importWorkerCheckpoints,
  listExportableWorkerCheckpoints,
} from '../runtime/worker-checkpoints.js';
import {
  importWorkspaceApplyPlans,
  listExportableWorkspaceApplyPlans,
} from '../runtime/workspace-apply-plans.js';
import {
  importWorkspaceApplyResults,
  listExportableWorkspaceApplyResults,
} from '../runtime/workspace-apply-results.js';
import {
  importWorkspaceQuarantineRecords,
  listExportableWorkspaceQuarantineRecords,
} from '../runtime/workspace-quarantine-records.js';
import {
  importWorkspaceReconciliationRecords,
  listExportableWorkspaceReconciliationRecords,
} from '../runtime/workspace-reconciliation-records.js';
import {
  importWorkspaceSyncRecords,
  listExportableWorkspaceSyncRecords,
} from '../runtime/workspace-sync-records.js';
import {
  importWorkspaceVaultGrants,
  listExportableWorkspaceVaultGrants,
} from '../vault/vault-grants.js';
import {
  importUnboundWorkspaceVaultReference,
  listWorkspaceVaultReferences,
} from '../vault/vault-references.js';
import {
  importWorkspaceVaultUseRecords,
  listExportableWorkspaceVaultUseRecords,
} from '../vault/vault-use-records.js';
import {
  importVaultInjectionPlans,
  listExportableVaultInjectionPlans,
} from '../vault-injection-plans.js';
import {
  importVaultInjectionReceipts,
  listExportableVaultInjectionReceipts,
} from '../vault-injection-receipts.js';
import {
  importWorkspaceRepositoryResources,
  listExportableWorkspaceRepositoryResources,
} from '../workspace/repository-store.js';
import { listExportableWorkspaceMaterialRows } from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import { openWorkspaceDbAtRoot } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import {
  artifactReviews,
  threadMaterialBindings,
  workspaceMaterialRevisions,
  workspaceMaterials,
} from './schema/index.js';
import {
  splitWorkspaceArchivePath,
  stageWorkspaceArchive,
  WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE,
} from './workspace-archive.js';
import {
  dryRunWorkspaceImport,
  type VerifiedWorkspaceExportTree,
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  type WorkspaceImportDryRunReport,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
} from './workspace-file-records.js';
import {
  readWorkspaceImportSnapshot,
  verifyImportedWorkerContextPackageSnapshot,
  type WorkspaceImportSnapshot,
} from './workspace-import.js';
import {
  readWorkspacePortableFileState,
  writeWorkspacePortableFileState,
} from './workspace-portable-file-state.js';

/**
 * Returns the first available imported workspace id using numeric suffixes.
 *
 * @param baseId Preferred imported workspace id.
 * @param exists Target workspace existence predicate.
 * @returns Available workspace id.
 */
function nextImportedWorkspaceId(baseId: string, exists: (workspaceId: string) => boolean): string {
  let workspaceId = baseId;
  let suffix = 2;
  while (exists(workspaceId)) {
    workspaceId = `${baseId}_${suffix}`;
    suffix += 1;
  }
  return workspaceId;
}

/**
 * Returns whether an imported workspace id is occupied in memory or on disk.
 *
 * @param coreDb Optional Core database carrying the deployment-wide workspace registry.
 * @param store Current user Store.
 * @param dataRoot Canonical data root.
 * @param workspaceId Candidate workspace id.
 * @returns True when either owner already has the id.
 */
function importedWorkspaceExists(
  coreDb: CoreDb | undefined,
  store: FsStore,
  dataRoot: string,
  workspaceId: string
): boolean {
  assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
  if (
    coreDb?.sqlite
      .prepare('SELECT 1 FROM workspace_registry WHERE workspace_id = ? LIMIT 1')
      .get(workspaceId)
  ) {
    return true;
  }

  try {
    store.getWorkspace(workspaceId);
    return true;
  } catch {
    return Boolean(
      lstatSync(join(dataRoot, 'workspaces', workspaceId), {
        throwIfNoEntry: false,
      })
    );
  }
}

/**
 * Checks whether the current source owner may consume a server-managed export.
 *
 * Foreign deployment handles are never portable input. Current and predecessor handles remain
 * private to the source owner and require the workspace.export operation.
 *
 * @param dataRoot Canonical data root carrying the current deployment marker.
 * @param store Current user Store.
 * @param actor Authenticated actor whose current source-export authority is required.
 * @param verified Verified export tree whose manifest identifies the source Workspace.
 * @param coreDb Optional Core membership and policy authority.
 * @returns True when the export may be previewed or imported by this store.
 */
function canReadWorkspaceExport(
  dataRoot: string,
  store: FsStore,
  actor: AuthVariables['actor'],
  verified: VerifiedWorkspaceExportTree,
  coreDb: CoreDb | undefined
): boolean {
  const marker = readDataRootLayoutMarker(dataRoot);
  if (
    verified.manifest.sourceDeploymentId !== marker.deploymentId &&
    verified.manifest.sourceDeploymentId !== marker.predecessorDeploymentId
  ) {
    return false;
  }

  if (coreDb) {
    return isWorkspaceOperationAuthorized(coreDb, actor, verified.manifest.workspaceId, {
      mutating: false,
      policyOperation: 'workspace.export',
    });
  }

  try {
    store.getWorkspace(verified.manifest.workspaceId);
  } catch {
    return false;
  }

  return true;
}

/**
 * Checks whether an archive may cross the target deployment trust boundary.
 *
 * Foreign archives use the authenticated importer as target authority. Current or predecessor
 * archives still require the active source owner and workspace.export authority.
 *
 * @param dataRoot Canonical target data root.
 * @param store Current user Store.
 * @param actor Authenticated importing actor.
 * @param verified Verified archive tree.
 * @param coreDb Optional Core membership and policy authority.
 * @returns True when the archive may be previewed or imported.
 */
function canImportWorkspaceArchive(
  dataRoot: string,
  store: FsStore,
  actor: AuthVariables['actor'],
  verified: VerifiedWorkspaceExportTree,
  coreDb: CoreDb | undefined
): boolean {
  const marker = readDataRootLayoutMarker(dataRoot);
  if (
    verified.manifest.sourceDeploymentId !== marker.deploymentId &&
    verified.manifest.sourceDeploymentId !== marker.predecessorDeploymentId
  ) {
    return true;
  }
  return canReadWorkspaceExport(dataRoot, store, actor, verified, coreDb);
}

/** Writes one canonical NUL-terminated USTAR octal field. */
function writeWorkspaceArchiveOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  if (encoded.length !== length) {
    throw new Error('Workspace export value cannot be represented by POSIX USTAR.');
  }
  header.write(encoded, offset, length, 'ascii');
}

/** Returns one deterministic strict POSIX USTAR header. */
function workspaceArchiveHeader(path: string, type: 'directory' | 'file', size: number): Buffer {
  const { name, prefix } = splitWorkspaceArchivePath(path);
  const header = Buffer.alloc(512);
  name.copy(header, 0);
  writeWorkspaceArchiveOctal(header, 100, 8, type === 'directory' ? 0o755 : 0o644);
  writeWorkspaceArchiveOctal(header, 108, 8, 0);
  writeWorkspaceArchiveOctal(header, 116, 8, 0);
  writeWorkspaceArchiveOctal(header, 124, 12, size);
  writeWorkspaceArchiveOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = type === 'directory' ? 53 : 48;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeWorkspaceArchiveOctal(header, 329, 8, 0);
  writeWorkspaceArchiveOctal(header, 337, 8, 0);
  prefix.copy(header, 345);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const encodedChecksum = `${checksum.toString(8).padStart(6, '0')}\0 `;
  if (encodedChecksum.length !== 8) {
    throw new Error('Workspace export checksum cannot be represented by POSIX USTAR.');
  }
  header.write(encodedChecksum, 148, 8, 'ascii');
  return header;
}

/** Writes one archive chunk and waits for the destination to accept it. */
function writeWorkspaceArchiveBytes(
  archive: PassThrough,
  bytes: Uint8Array<ArrayBufferLike>
): Promise<void> {
  return new Promise((resolve, reject) => {
    archive.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

/** Appends one strict POSIX USTAR entry. */
async function appendWorkspaceArchiveEntry(
  archive: PassThrough,
  path: string,
  type: 'directory' | 'file',
  content: Buffer<ArrayBufferLike> = Buffer.alloc(0)
): Promise<void> {
  await writeWorkspaceArchiveBytes(archive, workspaceArchiveHeader(path, type, content.byteLength));
  if (content.byteLength > 0) {
    await writeWorkspaceArchiveBytes(archive, content);
  }
  const padding = (512 - (content.byteLength % 512)) % 512;
  if (padding > 0) {
    await writeWorkspaceArchiveBytes(archive, Buffer.alloc(padding));
  }
}

/**
 * Streams one verified export tree into a canonical tar pack.
 *
 * @param archive Destination tar pack.
 * @param verified Export bytes returned by one completed verification.
 */
async function writeWorkspaceArchive(
  archive: PassThrough,
  verified: VerifiedWorkspaceExportTree
): Promise<void> {
  const files = new Map<string, Buffer>([
    [WORKSPACE_EXPORT_MANIFEST_FILE, Buffer.from(verified.manifestText)],
    ...[...verified.fileContents].map(([path, text]) => [path, Buffer.from(text)] as const),
  ]);
  const directories = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length > 0) {
      directories.add(`${parts.join('/')}/`);
      parts.pop();
    }
  }
  const comparePaths = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right));
  for (const directory of [...directories].sort(comparePaths)) {
    await appendWorkspaceArchiveEntry(archive, directory, 'directory');
  }
  for (const [path, content] of [...files].sort(([left], [right]) => comparePaths(left, right))) {
    await appendWorkspaceArchiveEntry(archive, path, 'file', content);
  }
  await writeWorkspaceArchiveBytes(archive, Buffer.alloc(1024));
  archive.end();
}

/**
 * Verifies that request path handles identify the manifest stored at that path.
 *
 * @param report Verified import preview.
 * @param sourceWorkspaceId Requested source workspace handle.
 * @param exportId Requested export handle.
 */
function assertRequestedExportHandles(
  report: { sourceWorkspaceId: string; exportId: string },
  sourceWorkspaceId: string,
  exportId: string
): void {
  if (report.sourceWorkspaceId !== sourceWorkspaceId || report.exportId !== exportId) {
    throw new Error('Workspace import path handles do not match the export manifest.');
  }
}

/**
 * Resolves one existing server-managed export without following directory links.
 *
 * @param dataRoot Canonical data root.
 * @param workspaceId Source workspace handle.
 * @param exportId Export handle.
 * @returns Existing export root.
 * @throws Error when a handle is unsafe or any owning directory is missing or linked.
 */
export function existingWorkspaceExportRoot(
  dataRoot: string,
  workspaceId: string,
  exportId: string
): string {
  assertSafeWorkspacePathSegment(workspaceId, 'Source workspace id');
  assertSafeWorkspacePathSegment(exportId, 'Export id');
  const exportsRoot = join(dataRoot, 'server', 'exports');
  const workspacesRoot = join(exportsRoot, 'workspaces');
  const workspaceRoot = join(workspacesRoot, workspaceId);
  const exportRoot = join(workspaceRoot, exportId);

  for (const path of [exportsRoot, workspacesRoot, workspaceRoot, exportRoot]) {
    assertCanonicalDirectory(path);
  }
  return exportRoot;
}

/**
 * Collects every portable workspace-database row family for one export.
 *
 * @param coreDb Optional Core database whose presence enables durable workspace rows.
 * @param workspaceId Exported workspace id.
 * @param repositoryWorkspaceDb Workspace database resolver.
 * @returns Portable workspace-database row families, or empty families without Core storage.
 * @throws Error when workspace database access or row validation fails.
 */
function collectWorkspaceExportRows(
  coreDb: CoreDb | undefined,
  workspaceId: string,
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb
) {
  if (!coreDb) {
    return {
      auditEvents: [],
      agentEnvironmentPackageSnapshots: [],
      capabilityCalls: [],
      evidenceBundles: [],
      gitPushRecords: [],
      goalPlanRecords: [],
      goalRecords: [],
      goalReviewRecords: [],
      goalTasks: [],
      goalVerificationRecords: [],
      mcpToolSchemaSnapshots: [],
      permissionDecisions: [],
      resolvedAgentSetups: [],
      runtimeEvidence: [],
      usageRecords: [],
      vaultUseRecords: [],
      workerCheckpoints: [],
      workspaceApplyPlans: [],
      workspaceApplyResults: [],
      workspaceReconciliationRecords: [],
      workspaceQuarantineRecords: [],
      workspaceRepositories: [],
      workspaceSyncRecords: {
        backendWorkspaceHandles: [],
        changeSets: [],
        inputSnapshots: [],
        materializationRecords: [],
        stagedReviews: [],
        workerOutputManifests: [],
      },
      artifactReviews: [],
      workspaceMaterialRows: { bindings: [], materials: [], revisions: [] },
    };
  }

  const workspaceDb = repositoryWorkspaceDb(workspaceId);
  try {
    return workspaceDb.sqlite.transaction(() => {
      const workspaceSyncRecords = listExportableWorkspaceSyncRecords(workspaceDb, workspaceId);
      const workspaceMaterialRows = listExportableWorkspaceMaterialRows(workspaceDb);
      return {
        artifactReviews: listExportableArtifactReviews(workspaceDb),
        auditEvents: listWorkspaceAuditEvents(workspaceDb, workspaceId),
        agentEnvironmentPackageSnapshots: listExportableAgentEnvironmentPackageSnapshots(
          workspaceDb,
          workspaceId
        ),
        capabilityCalls: listWorkspaceCapabilityCalls(workspaceDb, workspaceId),
        evidenceBundles: listWorkspaceEvidenceBundles(workspaceDb, workspaceId),
        gitPushRecords: listExportableGitPushRecords(workspaceDb, workspaceId),
        goalRecords: listExportableGoalRecords(workspaceDb, workspaceId),
        goalPlanRecords: listExportableGoalPlanRecords(workspaceDb, workspaceId),
        goalReviewRecords: listExportableGoalReviewRecords(workspaceDb, workspaceId),
        goalTasks: listExportableGoalTasks(workspaceDb, workspaceId),
        goalVerificationRecords: listExportableGoalVerificationRecords(workspaceDb, workspaceId),
        mcpToolSchemaSnapshots: listExportableMcpToolSchemaSnapshots(workspaceDb, workspaceId),
        permissionDecisions: listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId),
        resolvedAgentSetups: listExportableResolvedAgentSetups(workspaceDb, workspaceId),
        runtimeEvidence: listWorkspaceRuntimeEvidence(workspaceDb, workspaceId),
        usageRecords: listWorkspaceUsageRecords(workspaceDb, workspaceId),
        vaultUseRecords: listExportableWorkspaceVaultUseRecords(workspaceDb, workspaceId),
        workerCheckpoints: listExportableWorkerCheckpoints(workspaceDb, workspaceId),
        workspaceApplyPlans: listExportableWorkspaceApplyPlans(workspaceDb, workspaceId),
        workspaceApplyResults: listExportableWorkspaceApplyResults(workspaceDb, workspaceId),
        workspaceReconciliationRecords: listExportableWorkspaceReconciliationRecords(
          workspaceDb,
          workspaceId
        ),
        workspaceQuarantineRecords: listExportableWorkspaceQuarantineRecords(
          workspaceDb,
          workspaceId
        ),
        workspaceRepositories: listExportableWorkspaceRepositoryResources(workspaceDb, workspaceId),
        workspaceMaterialRows,
        workspaceSyncRecords,
      };
    })();
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Replays every portable workspace-database row into one staged workspace database.
 *
 * @param input Core database, staged workspace, verified snapshot, and import lineage.
 * @throws Error when migration, row replay, or usage recording fails.
 */
function importWorkspaceDatabaseRows({
  authorityUserId,
  coreDb,
  workspaceRoot,
  importedWorkspaceId,
  requestId,
  report,
  snapshot,
}: {
  /** Exact authenticated user that authorized the workspace import. */
  readonly authorityUserId: string;
  readonly coreDb: CoreDb;
  readonly workspaceRoot: string;
  readonly importedWorkspaceId: string;
  readonly requestId: string | null;
  readonly report: WorkspaceImportDryRunReport;
  readonly snapshot: WorkspaceImportSnapshot;
}): void {
  const workspaceDb = openWorkspaceDbAtRoot({
    dataRoot: coreDb.dataRoot,
    workspaceId: importedWorkspaceId,
    workspaceRoot,
  });

  try {
    applyScopedMigrations(workspaceDb);
    workspaceDb.sqlite.transaction(() => {
      if (snapshot.workspaceMaterials.length > 0) {
        workspaceDb.db.insert(workspaceMaterials).values(snapshot.workspaceMaterials).run();
      }
      if (snapshot.workspaceMaterialRevisions.length > 0) {
        workspaceDb.db
          .insert(workspaceMaterialRevisions)
          .values(snapshot.workspaceMaterialRevisions)
          .run();
      }
      if (snapshot.threadMaterialBindings.length > 0) {
        workspaceDb.db.insert(threadMaterialBindings).values(snapshot.threadMaterialBindings).run();
      }
      if (snapshot.artifactReviews.length > 0) {
        workspaceDb.db
          .insert(artifactReviews)
          .values(
            snapshot.artifactReviews.map(({ materialProposal, ...review }) => ({
              ...review,
              proposalMaterialId: materialProposal?.materialId ?? null,
              proposalBaseRevisionId: materialProposal?.baseRevisionId ?? null,
              proposalBaseContentDigest: materialProposal?.baseContentDigest ?? null,
            }))
          )
          .run();
      }
    })();
    importWorkspaceCapabilityUsageLedger({
      workspaceDb,
      capabilityCalls: snapshot.capabilityCalls,
      usageRecords: snapshot.usageRecords,
    });
    importWorkspaceAuditEvents({
      workspaceDb,
      sourceWorkspaceId: report.exportedWorkspaceId,
      targetWorkspaceId: importedWorkspaceId,
      events: snapshot.auditEvents,
    });
    importWorkspaceEvidenceBundles(workspaceDb, snapshot.evidenceBundles);
    importWorkspaceRuntimeEvidence(workspaceDb, snapshot.runtimeEvidence);
    importWorkspaceRepositoryResources(
      workspaceDb,
      importedWorkspaceId,
      snapshot.workspaceRepositories
    );
    importWorkspaceSyncRecords(workspaceDb, {
      backendWorkspaceHandles: snapshot.backendWorkspaceHandles,
      changeSets: snapshot.workspaceChangeSets,
      inputSnapshots: snapshot.workspaceInputSnapshots,
      materializationRecords: snapshot.workspaceMaterializationRecords,
      stagedReviews: snapshot.stagedWorkspaceReviews,
      workerOutputManifests: snapshot.workerOutputManifests,
    });
    importWorkspaceApplyPlans(workspaceDb, snapshot.workspaceApplyPlans);
    importWorkspaceApplyResults(workspaceDb, snapshot.workspaceApplyResults);
    importWorkspaceReconciliationRecords(workspaceDb, snapshot.workspaceReconciliationRecords);
    importWorkspaceQuarantineRecords(workspaceDb, snapshot.workspaceQuarantineRecords);
    importWorkspacePermissionDecisions(workspaceDb, snapshot.permissionDecisions);
    workspaceDb.sqlite.transaction(() => {
      importGoalRecords(workspaceDb, snapshot.goalRecords);
      importGoalPlanRecords(workspaceDb, snapshot.goalPlanRecords);
      importGoalTasks(workspaceDb, snapshot.goalTasks);
    })();
    importGoalReviewRecords(workspaceDb, snapshot.goalReviewRecords);
    importGoalVerificationRecords(workspaceDb, snapshot.goalVerificationRecords);
    importMcpToolSchemaSnapshots(workspaceDb, snapshot.mcpToolSchemaSnapshots);
    importResolvedAgentSetups(workspaceDb, snapshot.resolvedAgentSetups);
    importWorkspaceVaultUseRecords(workspaceDb, snapshot.vaultUseRecords);
    importWorkerCheckpoints(workspaceDb, snapshot.workerCheckpoints);
    importWorkspaceGitPushRecords(workspaceDb, snapshot.gitPushRecords);
    importAgentEnvironmentPackageSnapshots(workspaceDb, snapshot.agentEnvironmentPackageSnapshots);
    recordWorkspaceAuditEvent({
      workspaceDb,
      workspaceId: importedWorkspaceId,
      requestId,
      category: 'system',
      action: 'workspace.import',
      resource: `workspace:${importedWorkspaceId}`,
      outcome: 'succeeded',
      severity: 'info',
      summary: `Workspace import created ${importedWorkspaceId} from ${report.exportedWorkspaceId}.`,
    });
    const now = new Date();
    const storageImportId = randomUUID();
    const call = startCapabilityCall({
      authorityActor: { kind: 'user', id: authorityUserId },
      workspaceDb,
      callId: `cap_storage_import_${storageImportId}`,
      workspaceId: importedWorkspaceId,
      requestId,
      family: 'storage',
      operation: 'workspace.import.write',
      capabilityId: 'storage.workspace_import',
      providerRef: 'nanocore-storage',
      serviceRef: 'workspace-import',
      redactionClass: 'metadata-only',
      summary: `Workspace import ${importedWorkspaceId}`,
      now,
    });
    recordUsage({
      workspaceDb,
      call,
      records: [
        {
          usageId: `use_storage_import_files_${storageImportId}`,
          category: 'storage',
          unit: 'files',
          quantity: report.verification.fileCount,
          providerRef: 'nanocore-storage',
          source: 'workspace-import-inventory',
        },
        {
          usageId: `use_storage_import_bytes_${storageImportId}`,
          category: 'storage',
          unit: 'bytes',
          quantity: report.verification.totalBytes,
          providerRef: 'nanocore-storage',
          source: 'workspace-import-inventory',
        },
      ],
      now,
    });
    finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded', now });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Publishes one staged workspace with its Core-owned portable rows as one recoverable operation.
 *
 * @param coreDb Optional Core database for Vault and injection records.
 * @param store Current user Store.
 * @param ownerUserId Authenticated user that owns the imported Workspace.
 * @param snapshot Verified and reminted import snapshot.
 * @param stageWorkspace Staged file and workspace-database writer.
 * @returns Imported workspace record.
 * @throws Error when staged publication or transactional Core replay fails.
 */
function publishImportedWorkspace(
  coreDb: CoreDb | undefined,
  store: FsStore,
  ownerUserId: string,
  snapshot: WorkspaceImportSnapshot,
  stageWorkspace: (stage: ImportWorkspaceStage) => void
): ReturnType<FsStore['importWorkspaceSnapshot']> {
  const importWorkspaceState = () =>
    store.importWorkspaceSnapshot({
      ...snapshot,
      stageWorkspace,
    });
  if (!coreDb) {
    return importWorkspaceState();
  }

  let publishedWorkspaceId: string | null = null;
  try {
    return coreDb.sqlite.transaction(() => {
      const imported = importWorkspaceState();
      publishedWorkspaceId = imported.id;
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId,
        workspaceId: imported.id,
      });
      for (const reference of snapshot.vaultReferences) {
        importUnboundWorkspaceVaultReference(coreDb, reference);
      }
      importWorkspaceVaultGrants(coreDb, snapshot.vaultGrants);
      importVaultInjectionPlans(coreDb, snapshot.vaultInjectionPlans);
      importVaultInjectionReceipts(coreDb, snapshot.vaultInjectionReceipts);
      return imported;
    })();
  } catch (error) {
    if (publishedWorkspaceId) {
      store.rollbackImportedWorkspace(publishedWorkspaceId);
    }
    throw error;
  }
}

/**
 * Publishes one verified export through the existing coordinated import owner.
 *
 * @param input Verified bytes, target authorities, and request identity.
 * @returns Existing public Workspace import response.
 */
export function importVerifiedWorkspace({
  authorityUserId,
  coreDb,
  dataRoot,
  requestId,
  store,
  verified,
}: {
  readonly authorityUserId: string;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string;
  readonly requestId: string | null;
  readonly store: FsStore;
  readonly verified: VerifiedWorkspaceExportTree;
}) {
  const workspaceExists = (workspaceId: string) =>
    importedWorkspaceExists(coreDb, store, dataRoot, workspaceId);
  const report = dryRunWorkspaceImport({ verified, workspaceExists });
  const importedWorkspaceId =
    report.collision.status === 'available'
      ? report.collision.workspaceId
      : nextImportedWorkspaceId(report.collision.suggestedWorkspaceId, workspaceExists);
  const snapshot = readWorkspaceImportSnapshot({
    verified,
    targetWorkspaceId: importedWorkspaceId,
  });
  const stageWorkspace = ({ workspaceRoot }: ImportWorkspaceStage) => {
    writeWorkspacePortableFileState(workspaceRoot, snapshot.portableFileState);
    verifyImportedWorkerContextPackageSnapshot(snapshot, workspaceRoot);
    for (const [bundleId, text] of snapshot.runtimeProvenanceIndexes) {
      assertSafeWorkspacePathSegment(bundleId, 'Evidence bundle id');
      const path = join(
        workspaceRoot,
        'evidence',
        'bundles',
        bundleId,
        'runtime-origin-index.jsonl'
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    if (snapshot.dataSourceCatalog) {
      const catalogRoot = join(workspaceRoot, 'config');
      mkdirSync(catalogRoot, { recursive: true });
      writeFileSync(
        join(catalogRoot, 'data-sources.jsonc'),
        `${JSON.stringify(snapshot.dataSourceCatalog, null, 2)}\n`
      );
    }
    if (coreDb) {
      importWorkspaceDatabaseRows({
        authorityUserId,
        coreDb,
        workspaceRoot,
        importedWorkspaceId,
        requestId,
        report,
        snapshot,
      });
    }
  };
  const workspace = publishImportedWorkspace(
    coreDb,
    store,
    authorityUserId,
    snapshot,
    stageWorkspace
  );

  return WorkspaceImportResponseSchema.parse({
    ...report,
    mode: 'imported',
    requestId,
    importedWorkspaceId: workspace.id,
    workspace,
  });
}

/** Creates and verifies one server-managed portable Workspace export. */
export function createVerifiedWorkspaceExport({
  authorityUserId,
  coreDb,
  dataRoot,
  exportId = `wsexp_${randomUUID()}`,
  repositoryWorkspaceDb,
  store,
  workspaceId,
}: {
  readonly authorityUserId: string;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string;
  readonly exportId?: string;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly store: FsStore;
  readonly workspaceId: string;
}) {
  const workspace = store.getWorkspace(workspaceId);
  const threads = store.listThreads(workspaceId);
  const turns = threads.flatMap((thread) => store.listThreadTurns(workspaceId, thread.id));
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  assertCanonicalDirectory(workspaceRoot);
  const dataSourceCatalogPath = join(workspaceRoot, 'config', 'data-sources.jsonc');
  const dataSourceCatalog = existsSync(dataSourceCatalogPath)
    ? parseWorkspaceDataSourceCatalog(
        parseJsoncObject(readFileSync(dataSourceCatalogPath, 'utf8'), dataSourceCatalogPath)
      )
    : null;
  const workspaceRowFamilies = collectWorkspaceExportRows(
    coreDb,
    workspaceId,
    repositoryWorkspaceDb
  );
  const workspaceVaultGrants = coreDb
    ? listExportableWorkspaceVaultGrants(coreDb, workspaceId)
    : [];
  const workspaceVaultInjectionPlans = coreDb
    ? listExportableVaultInjectionPlans(
        coreDb,
        workspaceVaultGrants.map((grant) => grant.grantId)
      )
    : [];
  assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
  assertSafeWorkspacePathSegment(exportId, 'Export id');
  const exportsRoot = join(dataRoot, 'server', 'exports');
  const workspacesRoot = join(exportsRoot, 'workspaces');
  const workspaceExportsRoot = join(workspacesRoot, workspaceId);
  assertCanonicalDirectory(exportsRoot);
  for (const path of [workspacesRoot, workspaceExportsRoot]) {
    if (!lstatSync(path, { throwIfNoEntry: false })) {
      mkdirSync(path);
    }
    assertCanonicalDirectory(path);
  }
  const exportRoot = join(workspaceExportsRoot, exportId);
  const runtimeProvenanceIndexes = new Map<string, string>();
  for (const bundle of workspaceRowFamilies.evidenceBundles) {
    if (bundle.sourceKind !== 'worker-runtime-provenance-index') {
      continue;
    }
    assertSafeWorkspacePathSegment(bundle.id, 'Evidence bundle id');
    const text = readFileSync(
      join(workspaceRoot, 'evidence', 'bundles', bundle.id, 'runtime-origin-index.jsonl'),
      'utf8'
    );
    const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
    if (bundle.contentDigests.length !== 1 || bundle.contentDigests[0] !== digest) {
      throw new Error(`Runtime provenance index digest mismatch: ${bundle.id}`);
    }
    runtimeProvenanceIndexes.set(bundle.id, text);
  }
  const portableFileState = readWorkspacePortableFileState(
    workspaceRoot,
    turns.map(({ threadId, id }) => ({ threadId, turnId: id }))
  );
  const workerContextTraces = [...portableFileState.workerContextPackageFiles]
    .filter(([path]) => path.endsWith('/context-package.json'))
    .map(([path, text]) => [path, parseWorkerContextPackageTrace(JSON.parse(text))] as const);
  const tracedTurnIds = new Set(workerContextTraces.map(([, trace]) => trace.turnId));
  const workerBackedTurnIds = new Set(
    turns.filter((turn) => turn.agentSessionId != null).map((turn) => turn.id)
  );
  if (
    tracedTurnIds.size !== workerContextTraces.length ||
    tracedTurnIds.size !== workerBackedTurnIds.size ||
    [...tracedTurnIds].some((turnId) => !workerBackedTurnIds.has(turnId))
  ) {
    throw new Error('Worker Context Package coverage is incomplete.');
  }
  if (workerContextTraces.length > 0) {
    if (!coreDb) {
      throw new Error('Worker Context Package export requires durable authority.');
    }
    const workerContextDb = repositoryWorkspaceDb(workspaceId);
    try {
      const authorities = createWorkerContextPackageAuthorityReader({
        coreDb,
        store,
        workspaceDb: workerContextDb,
      });
      for (const [, trace] of workerContextTraces) {
        verifyPortableWorkerContextPackageTrace({
          authorities,
          trace,
          workspaceRoot,
        });
      }
    } finally {
      workerContextDb.sqlite.close();
    }
  }
  const exported = writeWorkspaceExportTree({
    exportRoot,
    exportId,
    sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    createdAt: new Date().toISOString(),
    workspace,
    threads,
    turns,
    knowledge: store.listKnowledge(workspaceId),
    knowledgeSources: store.listKnowledgeSources(workspaceId),
    knowledgeSourceMaterials: store.listKnowledgeSourceMaterials(workspaceId),
    itemRevisions: store.listWorkspaceItemRevisions(workspaceId),
    artifacts: store.listArtifacts(workspaceId),
    artifactReviews: workspaceRowFamilies.artifactReviews,
    threadMaterialBindings: workspaceRowFamilies.workspaceMaterialRows.bindings,
    workspaceMaterialRevisions: workspaceRowFamilies.workspaceMaterialRows.revisions,
    workspaceMaterials: workspaceRowFamilies.workspaceMaterialRows.materials,
    agentSessions: store.listWorkspaceAgentSessions(workspaceId),
    turnEvents: turns.map((turn) => [turn.id, store.getTurnEventsForExport(turn.id)]),
    portableFileState,
    ...(dataSourceCatalog ? { dataSourceCatalog } : {}),
    auditEvents: workspaceRowFamilies.auditEvents,
    agentEnvironmentPackageSnapshots: workspaceRowFamilies.agentEnvironmentPackageSnapshots,
    capabilityCalls: workspaceRowFamilies.capabilityCalls,
    evidenceBundles: workspaceRowFamilies.evidenceBundles,
    gitPushRecords: workspaceRowFamilies.gitPushRecords,
    goalRecords: workspaceRowFamilies.goalRecords,
    goalPlanRecords: workspaceRowFamilies.goalPlanRecords,
    goalReviewRecords: workspaceRowFamilies.goalReviewRecords,
    goalTasks: workspaceRowFamilies.goalTasks,
    goalVerificationRecords: workspaceRowFamilies.goalVerificationRecords,
    vaultInjectionPlans: workspaceVaultInjectionPlans,
    vaultInjectionReceipts: coreDb
      ? listExportableVaultInjectionReceipts(
          coreDb,
          workspaceVaultInjectionPlans.map((plan) => plan.planId)
        )
      : [],
    mcpToolSchemaSnapshots: workspaceRowFamilies.mcpToolSchemaSnapshots,
    permissionDecisions: workspaceRowFamilies.permissionDecisions,
    resolvedAgentSetups: workspaceRowFamilies.resolvedAgentSetups,
    runtimeEvidence: workspaceRowFamilies.runtimeEvidence,
    runtimeProvenanceIndexes,
    stagedWorkspaceReviews: workspaceRowFamilies.workspaceSyncRecords.stagedReviews,
    usageRecords: workspaceRowFamilies.usageRecords,
    vaultUseRecords: workspaceRowFamilies.vaultUseRecords,
    workerCheckpoints: workspaceRowFamilies.workerCheckpoints,
    workspaceApplyPlans: workspaceRowFamilies.workspaceApplyPlans,
    workspaceApplyResults: workspaceRowFamilies.workspaceApplyResults,
    workspaceReconciliationRecords: workspaceRowFamilies.workspaceReconciliationRecords,
    workspaceQuarantineRecords: workspaceRowFamilies.workspaceQuarantineRecords,
    backendWorkspaceHandles: workspaceRowFamilies.workspaceSyncRecords.backendWorkspaceHandles,
    workerOutputManifests: workspaceRowFamilies.workspaceSyncRecords.workerOutputManifests,
    workspaceChangeSets: workspaceRowFamilies.workspaceSyncRecords.changeSets,
    workspaceInputSnapshots: workspaceRowFamilies.workspaceSyncRecords.inputSnapshots,
    workspaceMaterializationRecords:
      workspaceRowFamilies.workspaceSyncRecords.materializationRecords,
    workspaceRepositories: workspaceRowFamilies.workspaceRepositories,
    vaultGrants: workspaceVaultGrants,
    vaultReferences: coreDb
      ? listWorkspaceVaultReferences(coreDb, workspaceId).map((reference) => ({
          sourceReferenceId: reference.referenceId,
          displayName: reference.displayName,
          secretKind: reference.secretKind,
          backendKind: reference.backendKind,
          createdAt: reference.createdAt,
          updatedAt: reference.updatedAt,
        }))
      : [],
  });
  const fileCount = exported.checkedFiles.length;
  const totalBytes = exported.manifest.contentInventory.reduce(
    (total, entry) => total + entry.bytes,
    0
  );

  if (coreDb) {
    const workspaceDb = repositoryWorkspaceDb(workspaceId);
    const now = new Date();

    try {
      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: authorityUserId },
        workspaceDb,
        callId: `cap_storage_export_${exportId}`,
        workspaceId,
        family: 'storage',
        operation: 'workspace.export.write',
        capabilityId: 'storage.workspace_export',
        providerRef: 'nanocore-storage',
        serviceRef: 'workspace-export',
        redactionClass: 'metadata-only',
        summary: `Workspace export ${exportId}`,
        now,
      });
      recordUsage({
        workspaceDb,
        call,
        records: [
          {
            usageId: `use_storage_export_files_${exportId}`,
            category: 'storage',
            unit: 'files',
            quantity: fileCount,
            providerRef: 'nanocore-storage',
            source: 'workspace-export-inventory',
          },
          {
            usageId: `use_storage_export_bytes_${exportId}`,
            category: 'storage',
            unit: 'bytes',
            quantity: totalBytes,
            providerRef: 'nanocore-storage',
            source: 'workspace-export-inventory',
          },
        ],
        now,
      });
      finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded', now });
    } finally {
      workspaceDb.sqlite.close();
    }
  }

  return {
    response: WorkspaceExportResponseSchema.parse({
      exportId: exported.manifest.id,
      workspaceId,
      manifest: exported.manifest,
      fileCount,
      totalBytes,
      checkedFiles: exported.checkedFiles,
    }),
    verified: exported,
  };
}

/**
 * Registers the complete workspace export and import App API feature path.
 *
 * @param dependencies Hono app and workspace portability storage dependencies.
 */
export function registerWorkspaceTransferRoutes({
  app,
  coreDb,
  dataRoot,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string | null;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'exportWorkspace', (c) => {
    if (!dataRoot) {
      return asApiError('Workspace export is unavailable.', 'workspace_export_unavailable', 503);
    }

    return c.json(
      createVerifiedWorkspaceExport({
        authorityUserId: c.get('actor').userId,
        coreDb,
        dataRoot,
        repositoryWorkspaceDb,
        store: requestStore(c),
        workspaceId: c.req.param('workspaceId'),
      }).response
    );
  });

  registerAppApiRoute(app, 'downloadWorkspaceExportArchive', (c) => {
    if (!dataRoot) {
      return asApiError(
        'Workspace export archive is unavailable.',
        'workspace_export_archive_unavailable',
        503
      );
    }

    const workspaceId = c.req.param('workspaceId');
    const exportId = c.req.param('exportId');
    try {
      const store = requestStore(c);
      const verified = verifyWorkspaceExportTree({
        exportRoot: existingWorkspaceExportRoot(dataRoot, workspaceId, exportId),
      });
      assertRequestedExportHandles(
        {
          sourceWorkspaceId: verified.manifest.workspaceId,
          exportId: verified.manifest.id,
        },
        workspaceId,
        exportId
      );
      if (!canReadWorkspaceExport(dataRoot, store, c.get('actor'), verified, coreDb)) {
        return asApiError(
          'Workspace export archive is unavailable.',
          'workspace_export_archive_forbidden',
          403
        );
      }

      const archive = new PassThrough();
      const compressed = createZstdCompress();
      archive.pipe(compressed);
      void writeWorkspaceArchive(archive, verified).catch((error: Error) => {
        archive.destroy(error);
        compressed.destroy(error);
      });
      return new Response(Readable.toWeb(compressed) as ReadableStream, {
        headers: {
          'content-disposition': `attachment; filename="${workspaceId}-${exportId}.openkit-workspace.tar.zst"`,
          'content-type': WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE,
        },
      });
    } catch {
      return asApiError(
        'Workspace export archive could not verify the requested export.',
        'workspace_export_archive_failed',
        400
      );
    }
  });

  registerAppApiRoute(app, 'dryRunWorkspaceArchiveImport', async (c) => {
    if (!dataRoot) {
      return asApiError(
        'Workspace archive import dry-run is unavailable.',
        'workspace_archive_import_unavailable',
        503
      );
    }

    let staged: Awaited<ReturnType<typeof stageWorkspaceArchive>> | null = null;
    try {
      staged = await stageWorkspaceArchive(c.req.raw, dataRoot);
      const store = requestStore(c);
      const verified = verifyWorkspaceExportTree({ exportRoot: staged.exportRoot });
      if (!canImportWorkspaceArchive(dataRoot, store, c.get('actor'), verified, coreDb)) {
        return asApiError(
          'Workspace archive is unavailable.',
          'workspace_archive_import_forbidden',
          403
        );
      }
      return c.json(
        WorkspaceImportDryRunResponseSchema.parse(
          dryRunWorkspaceImport({
            verified,
            workspaceExists: (workspaceId) =>
              importedWorkspaceExists(coreDb, store, dataRoot, workspaceId),
          })
        )
      );
    } catch {
      return asApiError(
        'Workspace archive import dry-run could not verify the request body.',
        'workspace_archive_import_dry_run_failed',
        400
      );
    } finally {
      staged?.remove();
    }
  });

  registerAppApiRoute(app, 'importWorkspaceArchive', async (c) => {
    if (!dataRoot) {
      return asApiError(
        'Workspace archive import is unavailable.',
        'workspace_archive_import_unavailable',
        503
      );
    }
    const requestId = c.req.header('x-openkit-request-id');
    if (!requestId || requestId.trim().length === 0) {
      return asApiError(
        'Workspace archive import requires x-openkit-request-id.',
        'invalid_request',
        400
      );
    }

    let staged: Awaited<ReturnType<typeof stageWorkspaceArchive>> | null = null;
    try {
      staged = await stageWorkspaceArchive(c.req.raw, dataRoot);
      const store = requestStore(c);
      const verified = verifyWorkspaceExportTree({ exportRoot: staged.exportRoot });
      if (!canImportWorkspaceArchive(dataRoot, store, c.get('actor'), verified, coreDb)) {
        return asApiError(
          'Workspace archive is unavailable.',
          'workspace_archive_import_forbidden',
          403
        );
      }
      return c.json(
        importVerifiedWorkspace({
          authorityUserId: c.get('actor').userId,
          coreDb,
          dataRoot,
          requestId,
          store,
          verified,
        })
      );
    } catch {
      return asApiError(
        'Workspace archive import could not verify or publish the request body.',
        'workspace_archive_import_failed',
        400
      );
    } finally {
      staged?.remove();
    }
  });

  registerAppApiRoute(app, 'dryRunWorkspaceImport', async (c) => {
    if (!dataRoot) {
      return asApiError(
        'Workspace import dry-run is unavailable.',
        'workspace_import_unavailable',
        503
      );
    }

    const parsed = WorkspaceImportDryRunRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const verified = verifyWorkspaceExportTree({
        exportRoot: existingWorkspaceExportRoot(
          dataRoot,
          parsed.data.sourceWorkspaceId,
          parsed.data.exportId
        ),
      });
      if (!canReadWorkspaceExport(dataRoot, store, c.get('actor'), verified, coreDb)) {
        return asApiError('Workspace export is unavailable.', 'workspace_import_forbidden', 403);
      }
      const report = dryRunWorkspaceImport({
        verified,
        workspaceExists: (workspaceId) =>
          importedWorkspaceExists(coreDb, store, dataRoot, workspaceId),
      });
      assertRequestedExportHandles(report, parsed.data.sourceWorkspaceId, parsed.data.exportId);

      return c.json(WorkspaceImportDryRunResponseSchema.parse(report));
    } catch {
      return asApiError(
        'Workspace import dry-run could not verify the requested export.',
        'workspace_import_dry_run_failed',
        400
      );
    }
  });

  registerAppApiRoute(app, 'importWorkspace', async (c) => {
    if (!dataRoot) {
      return asApiError('Workspace import is unavailable.', 'workspace_import_unavailable', 503);
    }

    const parsed = WorkspaceImportRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const store = requestStore(c);

    try {
      const verified = verifyWorkspaceExportTree({
        exportRoot: existingWorkspaceExportRoot(
          dataRoot,
          parsed.data.sourceWorkspaceId,
          parsed.data.exportId
        ),
      });
      if (!canReadWorkspaceExport(dataRoot, store, c.get('actor'), verified, coreDb)) {
        return asApiError('Workspace export is unavailable.', 'workspace_import_forbidden', 403);
      }
      const report = dryRunWorkspaceImport({
        verified,
        workspaceExists: (workspaceId) =>
          importedWorkspaceExists(coreDb, store, dataRoot, workspaceId),
      });
      assertRequestedExportHandles(report, parsed.data.sourceWorkspaceId, parsed.data.exportId);
      return c.json(
        importVerifiedWorkspace({
          authorityUserId: c.get('actor').userId,
          coreDb,
          dataRoot,
          requestId: parsed.data.requestId ?? null,
          store,
          verified,
        })
      );
    } catch {
      return asApiError(
        'Workspace import could not verify or publish the requested export.',
        'workspace_import_failed',
        400
      );
    }
  });
}
