import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { createZstdCompress } from 'node:zlib';
import {
  type CandidateSetRecord,
  CandidateSetRecordReaderSchema,
  WorkspaceExportResponseSchema,
} from '@openkit/app-api-schemas';
import { parseWorkspaceDataSourceCatalog, WorkspaceConfigSchema } from '@openkit/config-schema';
import {
  type ActorRef,
  allocateEntityId,
  compareCodeUnits,
  deriveEntityId,
  type Item,
  isEntityId,
  readRetainedV1,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { listExportableResolvedAgentSetups } from '../agents/setup-ledger.js';
import { asApiError } from '../api-errors.js';
import { listExportableArtifactReviews } from '../artifact-reviews.js';
import { listPortableWorkspaceAuditEvents } from '../audit-events.js';
import type { AuthVariables } from '../auth/middleware.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { projectWorkspaceCatalogExport } from '../catalog/catalog-portability.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createWorkerContextPackageAuthorityReader } from '../context/worker-context-authorities.js';
import {
  parseWorkerContextPackageTrace,
  verifyPortableWorkerContextPackageTrace,
} from '../context/worker-context-package.js';
import { listStoredWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { listExportableGenerativePresentations } from '../generative-ui/commands.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import { listExportableWorkspacePermissionDecisions } from '../policy/permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT } from '../policy/statements.js';
import { listExportableAgentEnvironmentPackageSnapshots } from '../runtime/aep-snapshot-ledger.js';
import { listExportableGoalState } from '../runtime/goal-owner.js';
import { listExportableMcpToolSchemaSnapshots } from '../runtime/mcp-tool-schema-snapshots.js';
import { recurringCanonicalTurnPublicationIssue } from '../runtime/recurring-turn-publication.js';
import { listWorkspaceRuntimeEvidence } from '../runtime/runtime-evidence.js';
import { listExportableWorkerCheckpoints } from '../runtime/worker-checkpoints.js';
import { listExportableWorkspaceApplyPlans } from '../runtime/workspace-apply-plans.js';
import { listExportableWorkspaceApplyResults } from '../runtime/workspace-apply-results.js';
import { listExportableWorkspaceQuarantineRecords } from '../runtime/workspace-quarantine-records.js';
import { listExportableWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-records.js';
import { listExportableWorkspaceSyncRecords } from '../runtime/workspace-sync-records.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import { listExportableWorkspaceVaultGrants } from '../vault/vault-grants.js';
import { listWorkspaceVaultReferences } from '../vault/vault-references.js';
import { listExportableWorkspaceVaultUseRecords } from '../vault/vault-use-records.js';
import { listExportableVaultInjectionPlans } from '../vault-injection-plans.js';
import { listExportableVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { assertWorkspaceDeletionRecoveryExportAuthority } from '../workspace-deletion-request.js';
import { listExportableWorkspaceMaterialRows } from '../workspace-materials.js';
import type { FileStorageAdmission } from './artifacts/file-admission.js';
import { withCanonicalFileWriteAdmission } from './canonical-write-capacity.js';
import { type CoreDb, openBootVerifiedWorkspaceDb, type WorkspaceDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import {
  assertExportableGenerativePresentations,
  listExportableLightAppFamilies,
} from './generative-portability.js';
import { exportRecurringPortableHistory } from './recurring-portable-history.js';
import { findAcceptedRecurringOccurrenceForQueue } from './recurring-records.js';
import { StoredTurnV1Schema } from './retained-work-metadata-v1.js';
import {
  parseWorkObservationRecord,
  readWorkObservations,
  readWorkObservationTurnBinding,
} from './work-observations.js';
import {
  assertWorkspaceArchiveFilePath,
  WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE,
  workspaceArchiveHeader,
} from './workspace-archive.js';
import {
  type VerifiedWorkspaceExportTree,
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
  type CaptureCoverageBinding,
  listNativeProducts,
  nativeProductScope,
  readCanonicalFile,
  readNativeProduct,
  readNativeTurnHistory,
  readWorkspaceTurnEvents,
} from './workspace-file-records.js';
import {
  parseWorkspaceRetrievalTraceFile,
  readWorkspacePortableFileState,
  serializeWorkspaceRetrievalTrace,
} from './workspace-portable-file-state.js';

/**
 * Requires the creating actor's current source-export authority and persisted export attribution.
 *
 * The existing storage call and usage rows are the creator proof; missing or contradictory proof fails closed. Every download requires current administrator export authority, independent of the retained history audience.
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
        )
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  } catch {
    return false;
  }
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
 * @param report Verified export handles from the manifest.
 * @param sourceWorkspaceId Requested source workspace handle.
 * @param exportId Requested export handle.
 */
export function assertRequestedExportHandles(
  report: { sourceWorkspaceId: string; exportId: string },
  sourceWorkspaceId: string,
  exportId: string
): void {
  if (report.sourceWorkspaceId !== sourceWorkspaceId || report.exportId !== exportId) {
    throw new Error('Workspace export handles do not match the export manifest.');
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
        knowledgeSelection: readWorkspaceNotebookSelection({
          workspaceDb,
          workspaceRoot: join(workspaceDb.dataRoot, 'workspaces', workspaceId),
          knowledgeBaseId: readDefaultKnowledgeBaseId({
            dataRoot: workspaceDb.dataRoot,
            scope: { kind: 'workspace', workspaceId },
          }),
        }),
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
  authorityUserId,
  coreDb,
  dataRoot,
  deletionRecoveryRequestId,
  exportId = allocateEntityId('wsexp'),
  repositoryWorkspaceDb,
  store,
  workspaceId,
}: {
  readonly authorityUserId: string;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string;
  /** Exact durable deletion request that grants only its recovery export authority. */
  readonly deletionRecoveryRequestId?: string;
  readonly exportId?: string;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
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
  if (deletionRecoveryContext)
    assertWorkspaceDeletionRecoveryExportAuthority(deletionRecoveryContext);
  const workspace = store.getWorkspace(workspaceId);
  const threads = store.listThreads(workspaceId);
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
    .sort((left, right) => compareCodeUnits(left.startedAt ?? '', right.startedAt ?? ''));

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
  const portableFileState = retainedPortableState;
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
  // Retained trace structure and digests remain required; administrator export has no per-source audience filter.
  for (const [path, trace] of portableFileState.retrievalTraceFiles) {
    parseWorkspaceRetrievalTraceFile(path, serializeWorkspaceRetrievalTrace(trace), workspaceId);
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
    ...('knowledgeSelection' in workspaceRowFamilies
      ? { sourceNotebookSelection: workspaceRowFamilies.knowledgeSelection }
      : {}),
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
    /** Actual actor retained only for usage attribution; primary admission precedes this writer. */
    readonly authorityActor?: ActorRef;
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
 * Registers the Workspace archive download binding. JSON export uses the verified export owner.
 *
 * @param dependencies Hono app and workspace export storage dependencies.
 */
export function registerWorkspaceTransferRoutes({
  app,
  coreDb,
  dataRoot,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string | null;
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
}
