import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { createZstdCompress } from 'node:zlib';
import {
  type CandidateSetRecord,
  CandidateSetRecordReaderSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { parseWorkspaceDataSourceCatalog, WorkspaceConfigSchema } from '@openkit/config-schema';
import {
  type ActorRef,
  allocateEntityId,
  deriveEntityId,
  type Item,
  isEntityId,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import {
  importResolvedAgentSetups,
  listExportableResolvedAgentSetups,
} from '../agents/setup-ledger.js';
import { asApiError } from '../api-errors.js';
import { listExportableArtifactReviews } from '../artifact-reviews.js';
import {
  importWorkspaceAuditEvents,
  listPortableWorkspaceAuditEvents,
  recordWorkspaceAuditEvent,
} from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import { isThreadVisible } from '../auth/thread-visibility.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import {
  finishCapabilityCall,
  finishCapabilityCallInDb,
  importWorkspaceCapabilityUsageLedger,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  recordUsageInDb,
  startCapabilityCall,
  startCapabilityCallInDb,
} from '../capability/usage-ledger.js';
import {
  projectWorkspaceCatalogExport,
  writeImportedWorkspaceCatalog,
} from '../catalog/catalog-portability.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { createWorkerContextPackageAuthorityReader } from '../context/worker-context-authorities.js';
import {
  parseWorkerContextPackageTrace,
  verifyPortableWorkerContextPackageTrace,
} from '../context/worker-context-package.js';
import {
  importWorkspaceEvidenceBundles,
  listStoredWorkspaceEvidenceBundles,
} from '../evidence-bundles.js';
import { listExportableGenerativePresentations } from '../generative-ui/commands.js';
import { assertConversationRetrievalTraceReadable } from '../internal-agents/assistant-history.js';
import {
  assertPortableWorkspaceNotebookDisclosure,
  bindImportedWorkspaceNotebookTraces,
  importedWorkspaceNotebookFiles,
  readPortableWorkspaceNotebookPages,
} from '../knowledge/notebook-workspace-portability.js';
import type { FsStore, ImportWorkspaceStage } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import {
  importWorkspacePermissionDecisions,
  listExportableWorkspacePermissionDecisions,
} from '../policy/permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT } from '../policy/statements.js';
import {
  importAgentEnvironmentPackageSnapshots,
  listExportableAgentEnvironmentPackageSnapshots,
} from '../runtime/aep-snapshot-ledger.js';
import { listExportableGoalState } from '../runtime/goal-owner.js';
import {
  importMcpToolSchemaSnapshots,
  listExportableMcpToolSchemaSnapshots,
} from '../runtime/mcp-tool-schema-snapshots.js';
import { recurringCanonicalTurnPublicationIssue } from '../runtime/recurring-turn-publication.js';
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
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
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
import { assertWorkspaceDeletionRecoveryExportAuthority } from '../workspace-deletion-request.js';
import { listExportableWorkspaceMaterialRows } from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { readArtifactVersionRecord } from './artifacts/artifact-version-records.js';
import type { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  reserveCanonicalFileWrite,
  withCanonicalFileWriteAdmission,
} from './canonical-write-capacity.js';
import {
  type CoreDb,
  openBootVerifiedWorkspaceDb,
  openWorkspaceDbAtRoot,
  type WorkspaceDb,
} from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import {
  assertExportableGenerativePresentations,
  importGenerativePresentations,
  importLightAppFamilies,
  listExportableLightAppFamilies,
} from './generative-portability.js';
import { assertKnowledgeRetrievalTraceReadable } from './index-rebuild.js';
import { applyScopedMigrations } from './migrate.js';
import { exportRecurringPortableHistory } from './recurring-portable-history.js';
import { findAcceptedRecurringOccurrenceForQueue } from './recurring-records.js';
import { StoredTurnV1Schema } from './retained-work-metadata-v1.js';
import {
  artifactReviews,
  evaluationCandidateSets,
  threadMaterialBindings,
  workspaceMaterialRevisions,
  workspaceMaterials,
} from './schema/index.js';
import {
  parseWorkObservationRecord,
  readWorkObservations,
  readWorkObservationTurnBinding,
} from './work-observations.js';
import {
  assertWorkspaceArchiveFilePath,
  splitWorkspaceArchivePath,
  stageWorkspaceArchive,
  WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE,
} from './workspace-archive.js';
import {
  dryRunWorkspaceImport,
  parsePortableWorkObservations,
  type VerifiedWorkspaceExportTree,
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  type WorkspaceImportDryRunReport,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
  type CaptureCoverageBinding,
  listNativeProducts,
  nativeProductScope,
  preserveDescriptiveRecord,
  readCanonicalFile,
  readNativeProduct,
  readNativeTurnHistory,
  readWorkspaceTurnEvents,
  writeFileAtomic,
} from './workspace-file-records.js';
import {
  readWorkspaceExportThreads,
  readWorkspaceImportSnapshot,
  verifyImportedWorkerContextPackageSnapshot,
  type WorkspaceImportSnapshot,
} from './workspace-import.js';
import {
  parseWorkspaceRetrievalTraceFile,
  readWorkspacePortableFileState,
  serializeWorkspaceRetrievalTrace,
  writeWorkspacePortableFileState,
} from './workspace-portable-file-state.js';

/**
 * Returns the first available owner-derived imported Workspace identity.
 *
 * @param sourceWorkspaceId Complete canonical source Workspace identity.
 * @param exists Target workspace existence predicate.
 * @returns Available workspace id.
 */
function nextImportedWorkspaceId(
  sourceWorkspaceId: string,
  exists: (workspaceId: string) => boolean
): string {
  let ordinal = 1;
  let workspaceId = deriveEntityId('ws', ['imported', sourceWorkspaceId, ordinal]);
  while (exists(workspaceId)) {
    ordinal += 1;
    workspaceId = deriveEntityId('ws', ['imported', sourceWorkspaceId, ordinal]);
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
export function importedWorkspaceExists(
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
 * Requires the creating actor's current source-export authority and persisted export attribution.
 *
 * The existing storage call and usage rows are the creator proof; missing or contradictory proof fails closed. Private history also requires the creator's current administrator eligibility, derived from verified content.
 *
 * @param dataRoot Canonical data root carrying the current deployment marker.
 * @param _store Store supplied by unchanged archive callers; creator authority comes only from Core.
 * @param actor Authenticated creator whose current source-export authority is required.
 * @param verified Verified export tree identifying the exact source Workspace and export.
 * @param coreDb Current Core membership and policy authority.
 * @returns True only for the currently authorized recorded creator.
 */
export function canReadWorkspaceExport(
  dataRoot: string,
  _store: FsStore,
  actor: AuthVariables['actor'],
  verified: VerifiedWorkspaceExportTree,
  coreDb: CoreDb | undefined
): boolean {
  const marker = readDataRootLayoutMarker(dataRoot);
  if (
    verified.manifest.sourceDeploymentId !== marker.deploymentId &&
    verified.manifest.sourceDeploymentId !== marker.predecessorDeploymentId
  )
    return false;
  if (
    !coreDb ||
    !isWorkspaceOperationAuthorized(coreDb, actor, verified.manifest.workspaceId, {
      mutating: false,
      policyOperation: 'workspace.export',
    })
  )
    return false;

  try {
    const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, verified.manifest.workspaceId);
    try {
      const rows = workspaceDb.sqlite
        .prepare(`
        SELECT call.schema_version AS callSchemaVersion, usage.schema_version AS schemaVersion, call.workspace_id AS call_workspace_id, call.family, call.operation,
               call.capability_id, call.status, usage.workspace_id, usage.usage_id,
               usage.category, usage.unit, usage.quantity, usage.model_id, usage.provider_ref,
               usage.source, usage.source_ids_json, usage.responsible_user_id
        FROM capability_calls call
        JOIN usage_records usage ON usage.capability_call_id = call.call_id
        WHERE call.call_id = ?
      `)
        .all(deriveEntityId('cap', ['storage_export', verified.manifest.id])) as Array<{
        callSchemaVersion: unknown;
        schemaVersion: unknown;
        call_workspace_id: string;
        family: string;
        operation: string;
        capability_id: string;
        status: string;
        workspace_id: string;
        usage_id: string;
        category: string;
        unit: string;
        quantity: number;
        model_id: string | null;
        provider_ref: string | null;
        source: string | null;
        source_ids_json: string;
        responsible_user_id: string | null;
      }>;
      for (const row of rows) {
        readRetainedV1(row, () => undefined);
        readRetainedV1({ schemaVersion: row.callSchemaVersion }, () => undefined);
      }
      const expected = new Map([
        ['files', verified.checkedFiles.length],
        [
          'bytes',
          verified.manifest.contentInventory.reduce((total, entry) => total + entry.bytes, 0),
        ],
      ]);
      return (
        rows.length === expected.size &&
        new Set(rows.map((row) => row.unit)).size === expected.size &&
        rows.every(
          (row) =>
            isEntityId('use', row.usage_id) &&
            row.category === 'storage' &&
            row.quantity === expected.get(row.unit) &&
            row.model_id === null &&
            row.provider_ref === 'nanocore-storage' &&
            row.source === 'workspace-export-inventory' &&
            row.source_ids_json === '[]' &&
            row.call_workspace_id === verified.manifest.workspaceId &&
            row.family === 'storage' &&
            row.operation === 'workspace.export.write' &&
            row.capability_id === 'storage.workspace_export' &&
            row.status === 'succeeded' &&
            row.workspace_id === verified.manifest.workspaceId &&
            row.responsible_user_id === actor.userId
        ) &&
        (!readWorkspaceExportThreads(verified.fileContents).some(
          (thread) => thread.visibility === 'private'
        ) ||
          isCurrentDeploymentAdministrator(coreDb, actor))
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  } catch {
    return false;
  }
}

/**
 * Checks whether an archive may cross the target deployment trust boundary.
 *
 * Foreign archives use the authenticated importer as target authority. Current or predecessor
 * archives still require current source Workspace eligibility and workspace.export authority.
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

/** Yields one strict POSIX USTAR entry from already bounded metadata bytes. */
function* workspaceArchiveEntry(
  path: string,
  type: 'directory' | 'file',
  content: Buffer<ArrayBufferLike> = Buffer.alloc(0)
): Generator<Buffer<ArrayBufferLike>> {
  yield workspaceArchiveHeader(path, type, content.byteLength);
  if (content.byteLength > 0) yield content;
  const padding = (512 - (content.byteLength % 512)) % 512;
  if (padding > 0) yield Buffer.alloc(padding);
}

/** Streams an inventoried original; cancellation closes its handle without a nested stream lifetime. */
async function* workspaceArchiveOriginal(
  path: string,
  source: string,
  expected: { readonly bytes: number; readonly digest: string }
): AsyncGenerator<Buffer<ArrayBufferLike>> {
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== expected.bytes)
      throw new Error('Workspace archive original size is inconsistent.');
    yield workspaceArchiveHeader(path, 'file', expected.bytes);
    const digest = createHash('sha256');
    let observed = 0;
    while (true) {
      const bytes = Buffer.allocUnsafe(65_536);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (bytesRead === 0) break;
      observed += bytesRead;
      if (observed > expected.bytes)
        throw new Error('Workspace archive original exceeds its inventoried size.');
      const chunk = bytes.subarray(0, bytesRead);
      digest.update(chunk);
      yield chunk;
    }
    if (observed !== expected.bytes || `sha256:${digest.digest('hex')}` !== expected.digest)
      throw new Error('Workspace archive original integrity is inconsistent.');
    const padding = (512 - (expected.bytes % 512)) % 512;
    if (padding > 0) yield Buffer.alloc(padding);
  } finally {
    await file.close();
  }
}

/** Yields the identical verified export tree in bytewise path order, with bounded original reads. */
async function* workspaceArchiveChunks(
  verified: VerifiedWorkspaceExportTree
): AsyncGenerator<Buffer<ArrayBufferLike>> {
  const files = new Map<string, Buffer>([
    [WORKSPACE_EXPORT_MANIFEST_FILE, Buffer.from(verified.manifestText)],
    ...[...verified.fileContents].map(([path, text]) => [path, Buffer.from(text)] as const),
    ...[...verified.binaryFileContents].map(([path, bytes]) => [path, Buffer.from(bytes)] as const),
  ]);
  const filePaths = [...files.keys(), ...verified.artifactPayloadFiles.keys()];
  const inventory = new Map(verified.manifest.contentInventory.map((entry) => [entry.path, entry]));
  const directories = new Set<string>();
  for (const path of filePaths) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length > 0) {
      directories.add(`${parts.join('/')}/`);
      parts.pop();
    }
  }
  const comparePaths = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right));
  for (const directory of [...directories].sort(comparePaths))
    yield* workspaceArchiveEntry(directory, 'directory');
  for (const path of filePaths.sort(comparePaths)) {
    const original = verified.artifactPayloadFiles.get(path);
    if (original) yield* workspaceArchiveOriginal(path, original, inventory.get(path)!);
    else yield* workspaceArchiveEntry(path, 'file', files.get(path)!);
  }
  yield Buffer.alloc(1024);
}

/**
 * Verifies that request path handles identify the manifest stored at that path.
 *
 * @param report Verified import preview.
 * @param sourceWorkspaceId Requested source workspace handle.
 * @param exportId Requested export handle.
 */
export function assertRequestedExportHandles(
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

/** Validates candidate payload ownership while retaining original nested descriptive content for export. */
function readExportableCandidateSets(workspaceDb: WorkspaceDb): CandidateSetRecord[] {
  const rows = workspaceDb.sqlite
    .prepare(
      'SELECT candidate_set_id AS candidateSetId, payload_json AS payloadJson FROM evaluation_candidate_sets WHERE workspace_id = ? ORDER BY rowid'
    )
    .all(workspaceDb.workspaceId) as Array<{ candidateSetId: string; payloadJson: string }>;
  return rows.map((row) => {
    const raw = JSON.parse(row.payloadJson);
    const record = CandidateSetRecordReaderSchema.parse(raw);
    if (
      record.workspaceId !== workspaceDb.workspaceId ||
      record.candidateSetId !== row.candidateSetId
    )
      throw new Error('Portable candidate set contradicts its Workspace row owner.');
    return raw as CandidateSetRecord;
  });
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
      mcpToolSchemaSnapshots: [],
      permissionDecisions: [],
      resolvedAgentSetups: [],
      runtimeEvidence: [],
      usageRecords: [],
      vaultUseRecords: [],
      goalState: { goals: [], cards: [], versions: [], tasks: [], terminalFacts: [] },
      workerCheckpoints: [],
      workspaceApplyPlans: [],
      workspaceApplyResults: [],
      workspaceReconciliationRecords: [],
      workspaceQuarantineRecords: [],
      workspaceSyncRecords: {
        backendWorkspaceHandles: [],
        changeSets: [],
        inputSnapshots: [],
        materializationRecords: [],
        stagedReviews: [],
        workerOutputManifests: [],
      },
      artifactReviews: [],
      evaluationCandidateSets: [],
      workspaceMaterialRows: { bindings: [], materials: [], revisions: [] },
      generativePresentations: [],
    };
  }

  const workspaceDb = repositoryWorkspaceDb(workspaceId);
  try {
    return workspaceDb.sqlite.transaction(() => {
      const workspaceSyncRecords = listExportableWorkspaceSyncRecords(workspaceDb, workspaceId);
      const workspaceMaterialRows = listExportableWorkspaceMaterialRows(workspaceDb);
      return {
        artifactReviews: listExportableArtifactReviews(workspaceDb),
        evaluationCandidateSets: readExportableCandidateSets(workspaceDb),
        auditEvents: listPortableWorkspaceAuditEvents(workspaceDb, workspaceId, coreDb),
        agentEnvironmentPackageSnapshots: listExportableAgentEnvironmentPackageSnapshots(
          workspaceDb,
          workspaceId
        ),
        capabilityCalls: listWorkspaceCapabilityCalls(workspaceDb, workspaceId),
        evidenceBundles: listStoredWorkspaceEvidenceBundles(workspaceDb, workspaceId),
        mcpToolSchemaSnapshots: listExportableMcpToolSchemaSnapshots(workspaceDb, workspaceId),
        permissionDecisions: listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId),
        resolvedAgentSetups: listExportableResolvedAgentSetups(workspaceDb, workspaceId),
        runtimeEvidence: listWorkspaceRuntimeEvidence(workspaceDb, workspaceId),
        usageRecords: listWorkspaceUsageRecords(workspaceDb, workspaceId),
        vaultUseRecords: listExportableWorkspaceVaultUseRecords(workspaceDb, workspaceId),
        goalState: listExportableGoalState(workspaceDb),
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
        workspaceMaterialRows,
        workspaceSyncRecords,
        generativePresentations: listExportableGenerativePresentations(workspaceDb),
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
  ownerUserId,
  coreDb,
  workspaceRoot,
  importedWorkspaceId,
  requestId,
  report,
  snapshot,
  appIds,
}: {
  /** Exact authenticated user that authorized the workspace import. */
  readonly authorityUserId: string;
  /** Restored tombstone owner for deleted recovery, or the importing user for ordinary imports. */
  readonly ownerUserId: string;
  readonly coreDb: CoreDb;
  readonly workspaceRoot: string;
  readonly importedWorkspaceId: string;
  readonly requestId: string | null;
  readonly report: WorkspaceImportDryRunReport;
  readonly snapshot: WorkspaceImportSnapshot;
  readonly appIds: ReadonlyMap<string, string>;
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
              schemaVersion: writeRetainedV1({}).schemaVersion,
              rangeFeedback: review.rangeFeedback ?? null,
              proposalMaterialId: materialProposal?.materialId ?? null,
              proposalBaseRevisionId: materialProposal?.baseRevisionId ?? null,
              proposalBaseContentDigest: materialProposal?.baseContentDigest ?? null,
            }))
          )
          .run();
      }
      if (snapshot.evaluationCandidateSets.length > 0) {
        workspaceDb.db
          .insert(evaluationCandidateSets)
          .values(
            snapshot.evaluationCandidateSets.map((record) => ({
              workspaceId: importedWorkspaceId,
              candidateSetId: record.candidateSetId,
              payloadJson: record,
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
      for (const goal of snapshot.goalState.goals)
        workspaceDb.sqlite
          .prepare(
            'INSERT INTO goals (goal_id,thread_id,payload_json,schema_version) VALUES (?,?,?,?)'
          )
          .run(
            goal.goalId,
            goal.threadId,
            JSON.stringify({
              ...goal,
              responsibleUserId: ownerUserId,
              responsibleActorContext: { kind: 'session', userId: ownerUserId },
            }),
            writeRetainedV1({}).schemaVersion
          );
      for (const card of snapshot.goalState.cards)
        workspaceDb.sqlite
          .prepare(
            'INSERT INTO goal_cards (card_id,goal_id,payload_json,schema_version) VALUES (?,?,?,?)'
          )
          .run(card.cardId, card.goalId, JSON.stringify(card), writeRetainedV1({}).schemaVersion);
      for (const version of snapshot.goalState.versions)
        workspaceDb.sqlite
          .prepare(
            'INSERT INTO goal_plan_versions (plan_version_id,goal_id,payload_json,schema_version) VALUES (?,?,?,?)'
          )
          .run(
            version.planVersionId,
            version.goalId,
            JSON.stringify(version),
            writeRetainedV1({}).schemaVersion
          );
      for (const link of snapshot.goalState.tasks)
        workspaceDb.sqlite
          .prepare(
            'INSERT INTO goal_card_tasks (thread_id,goal_id,card_id,payload_json,schema_version) VALUES (?,?,?,?,?)'
          )
          .run(
            link.threadId,
            link.goalId,
            link.cardId,
            JSON.stringify(link),
            writeRetainedV1({}).schemaVersion
          );
      for (const fact of snapshot.goalState.terminalFacts)
        workspaceDb.sqlite
          .prepare(
            'INSERT INTO task_turn_terminal_facts (turn_id,thread_id,payload_json,schema_version) VALUES (?,?,?,?)'
          )
          .run(fact.id, fact.threadId, JSON.stringify(fact), writeRetainedV1({}).schemaVersion);
    })();
    importMcpToolSchemaSnapshots(workspaceDb, snapshot.mcpToolSchemaSnapshots);
    importGenerativePresentations({
      workspaceDb,
      presentations: snapshot.generativePresentations,
      targetWorkspaceId: importedWorkspaceId,
      threadIds: snapshot.threadIds,
      turnIds: snapshot.turnIds,
      itemIds: snapshot.itemIds,
      appIds,
      presentationIds: snapshot.presentationIds,
    });
    importResolvedAgentSetups(workspaceDb, snapshot.resolvedAgentSetups);
    importWorkspaceVaultUseRecords(workspaceDb, snapshot.vaultUseRecords);
    importWorkerCheckpoints(workspaceDb, snapshot.workerCheckpoints);
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
    const call = startCapabilityCallInDb({
      authorityActor: { kind: 'user', id: authorityUserId },
      workspaceDb,
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
    recordUsageInDb({
      workspaceDb,
      call,
      records: [
        {
          category: 'storage',
          unit: 'files',
          quantity: report.verification.fileCount,
          providerRef: 'nanocore-storage',
          source: 'workspace-import-inventory',
        },
        {
          category: 'storage',
          unit: 'bytes',
          quantity: report.verification.totalBytes,
          providerRef: 'nanocore-storage',
          source: 'workspace-import-inventory',
        },
      ],
      now,
    });
    finishCapabilityCallInDb({ workspaceDb, callId: call.id, status: 'succeeded', now });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Carries descriptive observation additions through the existing verified identity remint. */
function retainedImportedObservations(
  snapshot: WorkspaceImportSnapshot,
  verified: VerifiedWorkspaceExportTree
): Map<string, string> {
  const sourceTurns = new Map([...snapshot.turnIds].map(([source, target]) => [target, source]));
  const sourceThreads = new Map(
    [...snapshot.threadIds].map(([source, target]) => [target, source])
  );
  const result = new Map<string, string>();
  for (const [turnId, text] of snapshot.turnObservations) {
    const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
    const sourceTurn = sourceTurns.get(turnId);
    const sourceThread = turn && sourceThreads.get(turn.threadId);
    const source =
      sourceTurn &&
      sourceThread &&
      verified.fileContents.get(
        `workspace-files/threads/${sourceThread}/turns/${sourceTurn}/observations.jsonl`
      );
    if (!turn || !sourceTurn || !sourceThread || source === undefined)
      throw new Error('Imported observations require their exact verified source.');
    const sourceLines = source
      .slice(0, source.lastIndexOf('\n') + 1)
      .split('\n')
      .slice(0, -1);
    const targetRows = parsePortableWorkObservations(text, turnId);
    if (sourceLines.length !== targetRows.length)
      throw new Error('Imported observations changed the committed row census.');
    const retained = targetRows.map((target, index) => {
      const original = JSON.parse(sourceLines[index]!);
      const previous = parseWorkObservationRecord(original);
      if (
        previous.turnId !== sourceTurn ||
        previous.seq !== target.seq ||
        previous.type !== target.type
      )
        throw new Error('Imported observation remint changed its source order or type.');
      // These two identity fields are explicit parser-owned aliases, even when the payload decoder omits them.
      const aliases = Object.fromEntries(
        ['id', 'turnId']
          .filter((key) => Object.hasOwn(original.payload, key))
          .map((key) => [key, key === 'id' ? target.id : target.turnId])
      );
      const raw = {
        ...original,
        id: target.id,
        turnId: target.turnId,
        payload: { ...original.payload, ...aliases },
      };
      const before = {
        ...previous,
        id: target.id,
        turnId: target.turnId,
        payload: { ...previous.payload, ...aliases },
      };
      const next = { ...target, payload: { ...target.payload, ...aliases } };
      const value = preserveDescriptiveRecord(raw, before, next);
      if (!isDeepStrictEqual(parseWorkObservationRecord(value), target))
        throw new Error('Imported descriptive observation fields changed known semantics.');
      return JSON.stringify(value);
    });
    result.set(turnId, retained.map((line) => `${line}\n`).join(''));
  }
  return result;
}

/** Installs observations only in a stopped, unpublished Workspace after native history and evidence initialization. */
function finalizeImportedWorkObservations(
  dataRoot: string,
  stage: ImportWorkspaceStage,
  snapshot: WorkspaceImportSnapshot,
  observations: ReadonlyMap<string, string>
): void {
  if (!observations.size) return;
  if (
    dirname(stage.workspaceRoot) !== join(dataRoot, 'workspaces', '.staging') ||
    existsSync(join(dataRoot, 'workspaces', stage.workspaceId))
  )
    throw new Error('Observation import requires the stopped private Workspace stage.');
  assertCanonicalDirectory(stage.workspaceRoot);
  const db = openWorkspaceDbAtRoot({
    dataRoot,
    workspaceId: stage.workspaceId,
    workspaceRoot: stage.workspaceRoot,
  });
  try {
    const bundles = new Map(
      listStoredWorkspaceEvidenceBundles(db, stage.workspaceId).map((bundle) => [bundle.id, bundle])
    );
    const prepared = [...observations].map(([turnId, text]) => {
      const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
      const coverage = snapshot.turnCaptureCoverage.get(turnId);
      if (!turn || !coverage || (text.length > 0 && !text.endsWith('\n')))
        throw new Error('Imported observations require exact Turn ownership and capture coverage.');
      const rows = parsePortableWorkObservations(text, turnId);
      const lines = text.split('\n').slice(0, -1);
      if (rows.length !== lines.length)
        throw new Error('Imported observation row census conflicts.');
      // Immutable originals were copied in the earlier stage. Verify bytes before opening the deciding SQL transaction.
      for (const row of rows) {
        if (row.type !== 'content.published') continue;
        for (const body of row.payload.bodies as {
          bundleId: string;
          sha256: string;
          bytes: number;
        }[]) {
          const bundle = bundles.get(body.bundleId);
          if (
            !bundle ||
            bundle.workspaceId !== stage.workspaceId ||
            bundle.threadId !== turn.threadId ||
            bundle.turnId !== turnId ||
            bundle.sourceKind !== 'work-observation-body' ||
            bundle.createdAt !== row.ts ||
            !['restricted-raw', 'legal-hold'].includes(bundle.retentionClass) ||
            bundle.sensitivityClass !== 'restricted' ||
            bundle.contentDigests.length !== 1 ||
            bundle.contentDigests[0]!.replace(/^sha256:/, '') !== body.sha256 ||
            !['promoted', 'expired'].includes(bundle.importStatus)
          )
            throw new Error('Imported observation publication lacks its exact evidence owner.');
          if (bundle.importStatus === 'expired') continue;
          assertSafeWorkspacePathSegment(bundle.id, 'Observation evidence bundle');
          const bytes = readCanonicalFile(
            join(stage.workspaceRoot, 'evidence', 'backend', bundle.id, 'raw', 'content')
          );
          if (
            bytes.byteLength !== body.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== body.sha256
          )
            throw new Error('Imported observation original bytes conflict with their publication.');
        }
      }
      return { turn, coverage, rows, lines };
    });
    db.sqlite.transaction(() => {
      if (db.sqlite.prepare('SELECT 1 FROM control_work_observations LIMIT 1').get())
        throw new Error('Observation import requires an empty native observation scope.');
      const insert = db.sqlite.prepare(
        'INSERT INTO control_work_observations (turn_id,sequence,id,schema_version,record_json) VALUES (?,?,?,1,?)'
      );
      for (const { turn, coverage, rows, lines } of prepared) {
        const binding = readWorkObservationTurnBinding(db, {
          threadId: turn.threadId,
          turnId: turn.id,
        });
        if (!isDeepStrictEqual(binding.coverage, coverage))
          throw new Error('Imported native capture coverage differs from the verified binding.');
        const record = {
          ...binding.raw,
          requiredFeatures: [
            ...new Set([...(binding.turn.requiredFeatures ?? []), 'openkit.work-observations.v1']),
          ],
        };
        readRetainedV1(record, () => StoredTurnV1Schema.parse(record));
        const text = JSON.stringify(record);
        if (Buffer.byteLength(text) > 64 * 1024)
          throw new Error('Imported observation Turn metadata exceeds its native bound.');
        db.sqlite
          .prepare('UPDATE control_turns SET revision=revision+1,record_json=? WHERE id=?')
          .run(text, turn.id);
        for (const [index, row] of rows.entries()) {
          const line = lines[index]!;
          if (Buffer.byteLength(line) > 64 * 1024)
            throw new Error('Imported observation metadata exceeds its native bound.');
          insert.run(turn.id, row.seq, row.id, line);
        }
        // The current native owner decides format, sequence, causal/reference lineage and publication coherence.
        if (
          !isDeepStrictEqual(
            readWorkObservations(db, { threadId: turn.threadId, turnId: turn.id }),
            rows
          )
        )
          throw new Error('Imported native observation rows differ from the verified remint.');
      }
    })();
  } finally {
    db.sqlite.close();
  }
}

/**
 * Publishes one staged workspace with its Core-owned portable rows as one recoverable operation.
 *
 * @param coreDb Optional Core database for Vault and injection records.
 * @param store Current user Store.
 * @param ownerUserId Importing user or verified deleted-resource tombstone owner.
 * @param snapshot Verified and reminted import snapshot.
 * @param stageWorkspace Staged file and workspace-database writer.
 * @param initialization Actual current importer and command attribution for the new Notebook.
 * @param fileWriteAdmission Request file capacity owner, scoped only to synchronous file publication.
 * @param finalizeNativeWorkspace Stopped private dependent SQL, after native product initialization and before publication.
 * @returns Imported workspace record after publication and the separate Core transaction.
 * @throws Error when staged publication or transactional Core replay fails.
 */
async function publishImportedWorkspace(
  coreDb: CoreDb | undefined,
  store: FsStore,
  ownerUserId: string,
  snapshot: WorkspaceImportSnapshot,
  stageWorkspace: (stage: ImportWorkspaceStage) => void,
  initialization: NonNullable<
    Parameters<FsStore['importWorkspaceSnapshot']>[0]['notebookInitialization']
  >,
  fileWriteAdmission?: FileStorageAdmission,
  finalizeNativeWorkspace?: (stage: ImportWorkspaceStage) => void
): ReturnType<FsStore['importWorkspaceSnapshot']> {
  const importWorkspaceState = () =>
    store.importWorkspaceSnapshot({
      ...snapshot,
      ...(fileWriteAdmission ? { fileWriteAdmission } : {}),
      stageWorkspace,
      ...(finalizeNativeWorkspace ? { finalizeNativeWorkspace } : {}),
      notebookInitialization: initialization,
      initialNotebookFiles: importedWorkspaceNotebookFiles(
        snapshot.portableFileState.nativeKnowledgePages
      ),
      ...(snapshot.portableFileState.workspaceSchema === null
        ? {}
        : { initialNotebookSchemaText: snapshot.portableFileState.workspaceSchema }),
    });
  if (!coreDb) {
    return importWorkspaceState();
  }

  // Private Workspace initialization completes before the separate Core SQL transaction.
  const imported = await importWorkspaceState();
  try {
    return coreDb.sqlite.transaction(() => {
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
    store.rollbackImportedWorkspace(imported.id);
    throw error;
  }
}

/**
 * Publishes one verified export through the existing coordinated import owner.
 *
 * @param input Verified bytes, target authorities, and request identity.
 * @returns Existing public Workspace import response.
 */
export async function importVerifiedWorkspace({
  authorityUserId,
  recoveryOwnerUserId,
  coreDb,
  dataRoot,
  requestId,
  store,
  verified,
  reloadConfiguration,
  fileAdmission,
}: {
  readonly fileAdmission?: FileStorageAdmission;
  readonly reloadConfiguration?: () => void;
  readonly authorityUserId: string;
  /** Trusted tombstone owner for deleted-resource recovery; ordinary imports use the invoking actor. */
  readonly recoveryOwnerUserId?: string;
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
      : nextImportedWorkspaceId(report.collision.workspaceId, workspaceExists);
  const snapshot = readWorkspaceImportSnapshot({
    verified,
    targetWorkspaceId: importedWorkspaceId,
    targetServerId: readDataRootLayoutMarker(dataRoot).deploymentId,
    resourcePolicySubjectEligible: (subject) => {
      // An exact deployment identity establishes the source namespace. A bare User id from another Server never does.
      if (
        verified.manifest.sourceDeploymentId !== readDataRootLayoutMarker(dataRoot).deploymentId ||
        subject.userId !== (recoveryOwnerUserId ?? authorityUserId) ||
        !coreDb ||
        !isCanonicalUserActive(coreDb, subject.userId)
      )
        return false;
      return (
        subject.kind === 'user' ||
        store
          .getWorkspaceResources(verified.manifest.workspaceId)
          .agents.some((agent) => agent.id === subject.agentId)
      );
    },
  });
  const observations = retainedImportedObservations(snapshot, verified);
  const stageWorkspace = ({ workspaceRoot }: ImportWorkspaceStage) => {
    snapshot.finalizeNotebookKnowledge?.(readPortableWorkspaceNotebookPages(workspaceRoot));
    writeWorkspacePortableFileState(workspaceRoot, {
      ...snapshot.portableFileState,
      retrievalTraceFiles: bindImportedWorkspaceNotebookTraces({
        workspaceRoot,
        workspaceId: importedWorkspaceId,
        knowledgeBaseId: snapshot.defaultKnowledgeBaseId,
        traces: snapshot.portableFileState.retrievalTraceFiles,
      }),
    });
    for (const [path, bytes] of snapshot.restrictedEvidenceFiles) {
      assertWorkspaceArchiveFilePath(path);
      const target = join(workspaceRoot, 'evidence', 'backend', path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileAtomic(target, bytes);
    }
    for (const [path, source] of snapshot.artifactPayloadFiles) {
      assertWorkspaceArchiveFilePath(path);
      const target = join(workspaceRoot, path);
      mkdirSync(dirname(target), { recursive: true });
      const byteLength = lstatSync(source).size;
      const reservation = reserveCanonicalFileWrite(byteLength);
      let release = false;
      try {
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        reservation?.recordWritten(byteLength);
        if (/^threads\/[^/]+\/turns\/[^/]+\/context-package\/originals\//.test(path))
          chmodSync(target, 0o444);
        release = true;
      } catch (error) {
        rmSync(target, { force: true });
        release = true;
        throw error;
      } finally {
        if (release) reservation?.release();
      }
    }
    snapshot.verifySourceOriginals(workspaceRoot);
    for (const [path, text] of snapshot.artifactVersionRecords) {
      assertWorkspaceArchiveFilePath(path);
      const target = join(workspaceRoot, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileAtomic(target, text);
    }
    for (const artifact of snapshot.artifacts) {
      for (let version = 1; version <= artifact.version; version += 1) {
        readArtifactVersionRecord(workspaceRoot, artifact.id, version);
      }
    }
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
    if (snapshot.agentResourceCatalog) {
      writeImportedWorkspaceCatalog(
        workspaceRoot,
        snapshot.agentResourceCatalog,
        snapshot.importedSkillPayloads
      );
    }
    const appIds = importLightAppFamilies({
      workspaceRoot,
      sourceWorkspaceId: report.exportedWorkspaceId,
      targetWorkspaceId: importedWorkspaceId,
      apps: snapshot.lightApps as never,
      definitions: snapshot.lightAppDefinitions as never,
      records: snapshot.lightAppRecords as never,
    });
    if (coreDb) {
      importWorkspaceDatabaseRows({
        authorityUserId,
        ownerUserId: recoveryOwnerUserId ?? authorityUserId,
        coreDb,
        workspaceRoot,
        importedWorkspaceId,
        requestId,
        report,
        snapshot,
        appIds,
      });
    }
  };
  const workspace = await publishImportedWorkspace(
    coreDb,
    store,
    recoveryOwnerUserId ?? authorityUserId,
    snapshot,
    stageWorkspace,
    {
      requestId: requestId ?? randomUUID(),
      producer: { kind: 'user', id: authorityUserId },
      instructionReference: `workspace.import:${verified.manifest.id}${verified.manifest.knowledgeNotebookRevision ? `:notebook:${verified.manifest.knowledgeNotebookRevision}` : ''}`,
    },
    fileAdmission,
    (stage) => finalizeImportedWorkObservations(dataRoot, stage, snapshot, observations)
  );

  reloadConfiguration?.();
  return WorkspaceImportResponseSchema.parse({
    ...report,
    mode: 'imported',
    requestId,
    importedWorkspaceId: workspace.id,
    workspace,
  });
}

/** Returns the only recovery export id owned by one Workspace deletion request. */
export function workspaceDeletionRecoveryExportId(requestId: string): string {
  assertSafeWorkspacePathSegment(requestId, 'Deletion request id');
  return deriveEntityId('wsexp', ['delete', requestId]);
}

/** Complete export Usage decision; verified file publication and database lifetime remain outside this supplied-handle body. */
export async function recordVerifiedWorkspaceExportUsage(
  writer: WorkspaceDb,
  input: {
    readonly authorityActor: ActorRef;
    readonly workspaceId: string;
    readonly exportId: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly now: Date;
  }
): Promise<void> {
  const call = await startCapabilityCall({
    authorityActor: input.authorityActor,
    workspaceDb: writer,
    callId: deriveEntityId('cap', ['storage_export', input.exportId]),
    workspaceId: input.workspaceId,
    family: 'storage',
    operation: 'workspace.export.write',
    capabilityId: 'storage.workspace_export',
    providerRef: 'nanocore-storage',
    serviceRef: 'workspace-export',
    redactionClass: 'metadata-only',
    summary: `Workspace export ${input.exportId}`,
    now: input.now,
  });
  await recordUsage({
    workspaceDb: writer,
    call,
    records: [
      {
        category: 'storage',
        unit: 'files',
        quantity: input.fileCount,
        providerRef: 'nanocore-storage',
        source: 'workspace-export-inventory',
      },
      {
        category: 'storage',
        unit: 'bytes',
        quantity: input.totalBytes,
        providerRef: 'nanocore-storage',
        source: 'workspace-export-inventory',
      },
    ],
    now: input.now,
  });
  await finishCapabilityCall({
    workspaceDb: writer,
    callId: call.id,
    status: 'succeeded',
    now: input.now,
  });
}

/** Publishes and verifies export bytes inside the existing synchronous capacity section. */
function createVerifiedWorkspaceExportFiles({
  authorityActor,
  authorityUserId,
  administratorEligible = false,
  coreDb,
  dataRoot,
  deletionRecoveryRequestId,
  exportId = allocateEntityId('wsexp'),
  repositoryWorkspaceDb,
  requestActor,
  store,
  workspaceId,
}: {
  readonly authorityActor?: ActorRef;
  readonly authorityUserId: string;
  /** Trusted current administrator eligibility; JSON input cannot select this audience. */
  readonly administratorEligible?: boolean;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string;
  /** Exact durable deletion request that grants only its recovery export authority. */
  readonly deletionRecoveryRequestId?: string;
  readonly exportId?: string;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestActor?: Actor;
  readonly store: FsStore;
  readonly workspaceId: string;
}) {
  if (!isEntityId('wsexp', exportId))
    throw new Error('Workspace export requires a canonical wsexp identity.');
  const deletionRecoveryContext =
    deletionRecoveryRequestId !== undefined
      ? {
          authorityUserId,
          coreDb,
          dataRoot,
          exportId,
          requestId: deletionRecoveryRequestId,
          workspaceId,
        }
      : undefined;
  const deletionRecoveryAuthorized = deletionRecoveryContext
    ? assertWorkspaceDeletionRecoveryExportAuthority(deletionRecoveryContext)
    : false;
  const workspace = store.getWorkspace(workspaceId);
  const threads = store.listThreads(workspaceId);
  if (
    !administratorEligible &&
    !deletionRecoveryAuthorized &&
    threads.some((thread) => thread.visibility === 'private')
  ) {
    throw new Error('Private Thread history requires a separately authorized export.');
  }
  assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  assertCanonicalDirectory(dataRoot);
  assertCanonicalDirectory(join(dataRoot, 'workspaces'));
  assertCanonicalDirectory(workspaceRoot);
  const canonicalItemRevisions: Item[] = [];
  const turnCaptureCoverage = new Map<string, CaptureCoverageBinding>();
  const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
  const threadIds = new Set(threads.map((thread) => thread.id));
  // Native rows select published history. Input/media directories cannot enumerate product authority.
  const turns = listNativeProducts(scope, 'turn')
    .map((snapshot) => {
      const published = readNativeTurnHistory(scope, snapshot.record.id as string);
      if (!published || !threadIds.has(published.turn.threadId))
        throw new Error('Workspace export cannot claim a Turn without its native Thread.');
      canonicalItemRevisions.push(...published.itemRevisions);
      if (published.captureCoverage)
        turnCaptureCoverage.set(published.turn.id, published.captureCoverage);
      return published.turn;
    })
    .sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));

  const canonicalTurns = new Map(turns.map((turn) => [turn.id, turn]));
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
  const turnObservations = new Map<string, string>();
  for (const turn of turns) {
    const root = join(workspaceRoot, 'threads', turn.threadId, 'turns', turn.id);
    const rawTurn = StoredTurnV1Schema.parse(readNativeProduct(scope, 'turn', turn.id)!.record);
    const declared =
      Array.isArray(rawTurn.requiredFeatures) &&
      rawTurn.requiredFeatures.includes('openkit.work-observations.v1');
    if (!declared) {
      if (existsSync(join(root, 'observations.jsonl')))
        throw new Error('Work observation file lacks its Turn required-feature declaration.');
      continue;
    }
    if (!coreDb) throw new Error('Work observation export requires durable evidence storage.');
    const observationDb = repositoryWorkspaceDb(workspaceId);
    try {
      const retained = observationDb.sqlite.transaction(() => {
        const input = { threadId: turn.threadId, turnId: turn.id };
        const binding = readWorkObservationTurnBinding(observationDb, input);
        const rows = readWorkObservations(observationDb, input);
        const raw = observationDb.sqlite
          .prepare(
            'SELECT record_json FROM control_work_observations WHERE turn_id=? ORDER BY sequence'
          )
          .all(turn.id) as { record_json: string }[];
        if (
          raw.length !== rows.length ||
          raw.some(
            (row, index) =>
              !isDeepStrictEqual(
                parseWorkObservationRecord(JSON.parse(row.record_json)),
                rows[index]
              )
          )
        )
          throw new Error('Native observation export changed its validated row census.');
        return {
          coverage: binding.coverage,
          text: raw.map((row) => `${row.record_json}\n`).join(''),
        };
      })();
      if (retained.coverage) turnCaptureCoverage.set(turn.id, retained.coverage);
      turnObservations.set(turn.id, retained.text);
    } finally {
      observationDb.sqlite.close();
    }
  }
  const restrictedEvidenceFiles = new Map<string, Uint8Array>();
  for (const bundle of workspaceRowFamilies.evidenceBundles) {
    if (
      !['work-observation-body', 'worker-runtime-provenance-raw'].includes(bundle.sourceKind) ||
      bundle.importStatus === 'expired'
    )
      continue;
    if (bundle.sourceKind === 'work-observation-body' && bundle.importStatus !== 'promoted')
      continue;
    assertSafeWorkspacePathSegment(bundle.id, 'Evidence bundle id');
    for (const [index, ref] of bundle.rawEvidenceRefs.entries()) {
      assertWorkspaceArchiveFilePath(ref.ref);
      const parts = [bundle.id, ...ref.ref.split('/')];
      let directory = workspaceRoot;
      for (const segment of ['evidence', 'backend']) {
        directory = join(directory, segment);
        assertCanonicalDirectory(directory);
      }
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        assertCanonicalDirectory(directory);
      }
      const bytes = readCanonicalFile(join(directory, parts.at(-1)!));
      const expected = bundle.contentDigests[index]?.replace(/^sha256:/, '');
      if (expected !== createHash('sha256').update(bytes).digest('hex'))
        throw new Error(`Restricted evidence digest mismatch: ${bundle.id}/${ref.ref}`);
      restrictedEvidenceFiles.set(`${bundle.id}/${ref.ref}`, bytes);
    }
  }
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
  const retainedPortableState = readWorkspacePortableFileState(workspaceRoot, {
    workspaceId,
    threads: threads.map(({ id }) => ({ threadId: id })),
    turns: turns.map(({ threadId, id }) => ({ threadId, turnId: id })),
  });
  const authoredPolicy = retainedPortableState.workspaceConfig
    ? (WorkspaceConfigSchema.parse(
        parseJsoncObject(retainedPortableState.workspaceConfig, 'config/workspace.jsonc')
      ).workspace.policy?.mediation ?? EMPTY_POLICY_DOCUMENT)
    : EMPTY_POLICY_DOCUMENT;
  if (!isDeepStrictEqual(authoredPolicy, store.getWorkspaceResourceAccess(workspaceId)))
    throw new Error('Workspace export requires matching saved and effective resource Policy.');
  if (
    !deletionRecoveryAuthorized &&
    threads.some(
      (thread) => !isThreadVisible(store, thread, authorityUserId, administratorEligible)
    )
  )
    throw new Error('Workspace export source audience is unavailable.');
  const portableFileState = retainedPortableState;
  if (!deletionRecoveryAuthorized) {
    if (!requestActor || !portableFileState.notebookRevision)
      throw new Error('Notebook export requires current source disclosure authority.');
    assertPortableWorkspaceNotebookDisclosure({
      dataRoot,
      workspaceId,
      notebookRevision: portableFileState.notebookRevision,
      pages: portableFileState.nativeKnowledgePages,
      access: {
        store,
        coreDb,
        actor: authorityActor ?? { kind: 'user', id: authorityUserId },
        requestActor,
      },
    });
  }
  // A missing current file cannot establish that a reserved Turn was never published.
  if (coreDb) {
    const accepted = coreDb.sqlite
      .prepare(
        "SELECT queue_entry_id FROM recurring_occurrences WHERE workspace_id = ? AND state = 'admission-accepted'"
      )
      .all(workspaceId) as { queue_entry_id: string | null }[];
    for (const row of accepted) {
      const entry = row.queue_entry_id
        ? requireSchedulerAdmissionEntry(coreDb, row.queue_entry_id)
        : null;
      if (
        !entry ||
        !findAcceptedRecurringOccurrenceForQueue(coreDb, entry.queueEntryId) ||
        recurringCanonicalTurnPublicationIssue(entry, canonicalTurns.get(entry.turnId) ?? null)
      )
        throw new Error('Recurring publication requires inspection before portable export.');
    }
  }
  const recurringHistory = exportRecurringPortableHistory(
    coreDb,
    workspaceId,
    retainedPortableState.recurringHistory ?? null,
    turns
  );
  if (
    portableFileState.retrievalTraceFiles.size > 0 &&
    !deletionRecoveryAuthorized &&
    (!authorityActor || !requestActor)
  ) {
    throw new Error('Workspace retrieval traces require current export authority.');
  }
  for (const [path, trace] of portableFileState.retrievalTraceFiles) {
    const { reference } = parseWorkspaceRetrievalTraceFile(
      path,
      serializeWorkspaceRetrievalTrace(trace),
      workspaceId
    );
    if (!deletionRecoveryAuthorized) {
      if ('sourceKind' in trace) {
        if (!coreDb || !requestActor)
          throw new Error('Conversation trace export requires current authority.');
        assertConversationRetrievalTraceReadable({
          store,
          coreDb,
          actor: requestActor,
          workspaceId,
          retrievalTraceRef: reference,
        });
        continue;
      }
      assertKnowledgeRetrievalTraceReadable({
        dataRoot,
        workspaceId,
        access: {
          store,
          coreDb,
          actor: authorityActor!,
          requestActor: requestActor!,
        },
        retrievalTraceRef: reference,
      });
    }
  }
  const workerContextTraces = [...portableFileState.workerContextPackageFiles]
    .filter(([path]) => path.endsWith('/context-package.json'))
    .map(
      ([path, text]) =>
        [
          path,
          parseWorkerContextPackageTrace(
            JSON.parse(text),
            Buffer.from(
              portableFileState.workerContextPackageFiles.get(
                path.replace(/context-package\.json$/, 'context-package/package.json')
              ) ?? '',
              'utf8'
            )
          ),
        ] as const
    );
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
          authorities: {
            ...authorities,
            // Historical validation must consume the same canonical records that export serializes.
            readTurn: (requestedWorkspaceId, threadId, turnId) => {
              const turn = canonicalTurns.get(turnId);
              return requestedWorkspaceId === workspaceId && turn?.threadId === threadId
                ? { ...turn, agentSessionId: turn.agentSessionId ?? null }
                : null;
            },
            readThreadItems: (requestedWorkspaceId, threadId) =>
              requestedWorkspaceId === workspaceId
                ? turns.filter((turn) => turn.threadId === threadId).flatMap((turn) => turn.items)
                : [],
          },
          trace,
          workspaceRoot,
        });
      }
    } finally {
      workerContextDb.sqlite.close();
    }
  }
  const lightApps = listExportableLightAppFamilies(dataRoot, workspaceId);
  const exported = writeWorkspaceExportTree({
    sourceWorkspaceRoot: join(dataRoot, 'workspaces', workspaceId),
    administratorEligible,
    ...(deletionRecoveryContext ? { deletionRecoveryContext } : {}),
    exportRoot,
    exportId,
    sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    createdAt: new Date().toISOString(),
    workspace,
    threads,
    turns,
    knowledge: store.listKnowledge(workspaceId),
    knowledgeSources: store.listKnowledgeSources(workspaceId),
    itemRevisions: canonicalItemRevisions,
    artifacts: store.listArtifacts(workspaceId),
    artifactReviews: workspaceRowFamilies.artifactReviews,
    evaluationCandidateSets: workspaceRowFamilies.evaluationCandidateSets,
    threadMaterialBindings: workspaceRowFamilies.workspaceMaterialRows.bindings,
    workspaceMaterialRevisions: workspaceRowFamilies.workspaceMaterialRows.revisions,
    workspaceMaterials: workspaceRowFamilies.workspaceMaterialRows.materials,
    agentSessions: store.listWorkspaceAgentSessions(workspaceId),
    turnEvents: turns.map((turn) => [turn.id, readWorkspaceTurnEvents(workspaceRoot, turn)]),
    portableFileState,
    recurringHistory,
    ...(dataSourceCatalog ? { dataSourceCatalog } : {}),
    agentResourceCatalog: projectWorkspaceCatalogExport(dataRoot, workspaceId),
    auditEvents: [...workspaceRowFamilies.auditEvents, ...lightApps.auditEvents],
    agentEnvironmentPackageSnapshots: workspaceRowFamilies.agentEnvironmentPackageSnapshots,
    capabilityCalls: workspaceRowFamilies.capabilityCalls,
    evidenceBundles: workspaceRowFamilies.evidenceBundles,
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
    restrictedEvidenceFiles,
    turnObservations,
    turnCaptureCoverage,
    stagedWorkspaceReviews: workspaceRowFamilies.workspaceSyncRecords.stagedReviews,
    usageRecords: workspaceRowFamilies.usageRecords,
    vaultUseRecords: workspaceRowFamilies.vaultUseRecords,
    goalState: workspaceRowFamilies.goalState,
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
    ...(() => {
      const generativePresentations = workspaceRowFamilies.generativePresentations;
      assertExportableGenerativePresentations(store, workspaceId, generativePresentations);
      return {
        lightApps: lightApps.apps,
        lightAppDefinitions: lightApps.definitions,
        lightAppRecords: lightApps.records,
        generativePresentations,
      };
    })(),
  });
  const fileCount = exported.checkedFiles.length;
  const totalBytes = exported.manifest.contentInventory.reduce(
    (total, entry) => total + entry.bytes,
    0
  );

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

/** Keeps export file publication synchronous, then awaits its native usage before exposing success. */
export async function createVerifiedWorkspaceExport(
  input: Parameters<typeof createVerifiedWorkspaceExportFiles>[0] & {
    readonly fileAdmission: FileStorageAdmission;
  }
) {
  const exported = withCanonicalFileWriteAdmission(input.fileAdmission, () =>
    createVerifiedWorkspaceExportFiles(input)
  );
  if (input.coreDb) {
    const workspaceDb = input.repositoryWorkspaceDb(input.workspaceId);
    try {
      await recordVerifiedWorkspaceExportUsage(workspaceDb, {
        authorityActor: input.authorityActor ?? { kind: 'user', id: input.authorityUserId },
        workspaceId: input.workspaceId,
        exportId: exported.response.exportId,
        fileCount: exported.response.fileCount,
        totalBytes: exported.response.totalBytes,
        now: new Date(),
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  }
  return exported;
}

/**
 * Registers the three Workspace archive streaming bindings; JSON transfer joins use the native owners above.
 *
 * @param dependencies Hono app and workspace portability storage dependencies.
 */
export function registerWorkspaceTransferRoutes({
  app,
  coreDb,
  dataRoot,
  fileAdmission,
  requestStore,
  reloadConfiguration,
}: {
  readonly reloadConfiguration?: () => void;
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string | null;
  readonly fileAdmission: FileStorageAdmission;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'workspace.archive-download', (c) => {
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

      const archive = Readable.from(workspaceArchiveChunks(verified), {
        objectMode: false,
        highWaterMark: 65_536,
      });
      const compressed = createZstdCompress();
      // Cancellation returns the producer's iterator and closes its original file.
      // Pipeline errors already terminate the response stream.
      void pipeline(archive, compressed).catch(() => undefined);
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

  registerAppApiRoute(app, 'workspace.archive-import-dry-run', async (c) => {
    if (!dataRoot) {
      return asApiError(
        'Workspace archive import dry-run is unavailable.',
        'workspace_archive_import_unavailable',
        503
      );
    }

    let staged: Awaited<ReturnType<typeof stageWorkspaceArchive>> | null = null;
    try {
      staged = await stageWorkspaceArchive(c.req.raw, dataRoot, fileAdmission);
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

  registerAppApiRoute(app, 'workspace.archive-import', async (c) => {
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
      staged = await stageWorkspaceArchive(c.req.raw, dataRoot, fileAdmission);
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
        await importVerifiedWorkspace({
          ...(reloadConfiguration ? { reloadConfiguration } : {}),
          authorityUserId: c.get('actor').userId,
          coreDb,
          dataRoot,
          fileAdmission,
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
}
