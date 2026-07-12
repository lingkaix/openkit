import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
import {
  importWorkspaceAuditEvents,
  listWorkspaceAuditEvents,
  recordWorkspaceAuditEvent,
} from '../audit-events.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  finishCapabilityCall,
  importWorkspaceCapabilityUsageLedger,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { parseJsoncObject } from '../config/jsonc.js';
import {
  importWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
} from '../evidence-bundles.js';
import { importInjectionPlans, listExportableInjectionPlans } from '../injection-plans.js';
import { importInjectionReceipts, listExportableInjectionReceipts } from '../injection-receipts.js';
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
  importGoalRecords,
  importGoalTasks,
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
  importPendingUserTurns,
  listExportablePendingUserTurns,
} from '../runtime/pending-user-turns.js';
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
  importWorkspaceSyncEvidenceBundles,
  listExportableWorkspaceSyncEvidenceBundles,
} from '../runtime/workspace-sync-evidence-bundles.js';
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
  importWorkspaceRepositoryResources,
  listExportableWorkspaceRepositoryResources,
} from '../workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import { openWorkspaceDbAtRoot } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import {
  dryRunWorkspaceImport,
  verifyWorkspaceExportTree,
  type WorkspaceImportDryRunReport,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
} from './workspace-file-records.js';
import { readWorkspaceImportSnapshot, type WorkspaceImportSnapshot } from './workspace-import.js';
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
      lstatSync(join(dataRoot, 'users', store.getUserId(), 'workspaces', workspaceId), {
        throwIfNoEntry: false,
      })
    );
  }
}

/**
 * Checks whether the current store may consume a same-deployment export.
 *
 * Exports originating from another deployment are portable input. Exports from the current or
 * predecessor deployment remain private to the source owner and require active server membership.
 *
 * @param dataRoot Canonical data root carrying the current deployment marker.
 * @param store Current user Store.
 * @param report Verified export preview.
 * @param isActiveWorkspaceMember Optional server membership predicate.
 * @returns True when the export may be previewed or imported by this store.
 */
function canReadWorkspaceExport(
  dataRoot: string,
  store: FsStore,
  report: WorkspaceImportDryRunReport,
  isActiveWorkspaceMember: ((userId: string, workspaceId: string) => boolean) | undefined
): boolean {
  const marker = readDataRootLayoutMarker(dataRoot);
  if (
    report.manifest.sourceDeploymentId !== marker.deploymentId &&
    report.manifest.sourceDeploymentId !== marker.predecessorDeploymentId
  ) {
    return true;
  }

  try {
    store.getWorkspace(report.exportedWorkspaceId);
  } catch {
    return false;
  }

  return isActiveWorkspaceMember?.(store.getUserId(), report.exportedWorkspaceId) ?? true;
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
function existingWorkspaceExportRoot(
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
 * @param store Current user Store.
 * @param workspaceId Exported workspace id.
 * @param repositoryWorkspaceDb Workspace database resolver.
 * @returns Portable workspace-database row families, or empty families without Core storage.
 * @throws Error when workspace database access or row validation fails.
 */
function collectWorkspaceExportRows(
  coreDb: CoreDb | undefined,
  store: FsStore,
  workspaceId: string,
  repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb
) {
  if (!coreDb) {
    return {
      auditEvents: [],
      agentEnvironmentPackageSnapshots: [],
      capabilityCalls: [],
      evidenceBundles: [],
      gitPushRecords: [],
      goalRecords: [],
      goalReviewRecords: [],
      goalTasks: [],
      goalVerificationRecords: [],
      mcpToolSchemaSnapshots: [],
      pendingUserTurns: [],
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
      workspaceSyncEvidenceBundles: [],
      workspaceRepositories: [],
      workspaceSyncRecords: {
        backendWorkspaceHandles: [],
        changeSets: [],
        inputSnapshots: [],
        materializationRecords: [],
        stagedReviews: [],
        workerOutputManifests: [],
      },
    };
  }

  const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
  try {
    const workspaceSyncRecords = listExportableWorkspaceSyncRecords(workspaceDb, workspaceId);
    return {
      auditEvents: listWorkspaceAuditEvents(workspaceDb, workspaceId),
      agentEnvironmentPackageSnapshots: listExportableAgentEnvironmentPackageSnapshots(
        workspaceDb,
        workspaceId
      ),
      capabilityCalls: listWorkspaceCapabilityCalls(workspaceDb, workspaceId),
      evidenceBundles: listWorkspaceEvidenceBundles(workspaceDb, workspaceId),
      gitPushRecords: listExportableGitPushRecords(workspaceDb, workspaceId),
      goalRecords: listExportableGoalRecords(workspaceDb, workspaceId),
      goalReviewRecords: listExportableGoalReviewRecords(workspaceDb, workspaceId),
      goalTasks: listExportableGoalTasks(workspaceDb, workspaceId),
      goalVerificationRecords: listExportableGoalVerificationRecords(workspaceDb, workspaceId),
      mcpToolSchemaSnapshots: listExportableMcpToolSchemaSnapshots(workspaceDb, workspaceId),
      pendingUserTurns: listExportablePendingUserTurns(workspaceDb, workspaceId),
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
      workspaceSyncEvidenceBundles: listExportableWorkspaceSyncEvidenceBundles(
        workspaceDb,
        workspaceId
      ),
      workspaceRepositories: listExportableWorkspaceRepositoryResources(workspaceDb, workspaceId),
      workspaceSyncRecords,
    };
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
  coreDb,
  store,
  workspaceRoot,
  importedWorkspaceId,
  requestId,
  report,
  snapshot,
}: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceRoot: string;
  readonly importedWorkspaceId: string;
  readonly requestId: string | null;
  readonly report: WorkspaceImportDryRunReport;
  readonly snapshot: WorkspaceImportSnapshot;
}): void {
  const workspaceDb = openWorkspaceDbAtRoot({
    dataRoot: coreDb.dataRoot,
    userId: store.getUserId(),
    workspaceId: importedWorkspaceId,
    workspaceRoot,
  });

  try {
    applyScopedMigrations(workspaceDb);
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
    importWorkspaceSyncEvidenceBundles(workspaceDb, snapshot.workspaceSyncEvidenceBundles);
    importWorkspacePermissionDecisions(workspaceDb, snapshot.permissionDecisions);
    importGoalRecords(workspaceDb, snapshot.goalRecords);
    importGoalTasks(workspaceDb, snapshot.goalTasks);
    importGoalReviewRecords(workspaceDb, snapshot.goalReviewRecords);
    importGoalVerificationRecords(workspaceDb, snapshot.goalVerificationRecords);
    importMcpToolSchemaSnapshots(workspaceDb, snapshot.mcpToolSchemaSnapshots);
    importPendingUserTurns(workspaceDb, snapshot.pendingUserTurns);
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
 * @param snapshot Verified and reminted import snapshot.
 * @param stageWorkspace Staged file and workspace-database writer.
 * @returns Imported workspace record.
 * @throws Error when staged publication or transactional Core replay fails.
 */
function publishImportedWorkspace(
  coreDb: CoreDb | undefined,
  store: FsStore,
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
        ownerUserId: store.getUserId(),
        workspaceId: imported.id,
      });
      for (const reference of snapshot.vaultReferences) {
        importUnboundWorkspaceVaultReference(coreDb, reference);
      }
      importWorkspaceVaultGrants(coreDb, snapshot.vaultGrants);
      importInjectionPlans(coreDb, snapshot.injectionPlans);
      importInjectionReceipts(coreDb, snapshot.injectionReceipts);
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
 * Registers the complete workspace export and import App API feature path.
 *
 * @param dependencies Hono app and workspace portability storage dependencies.
 */
export function registerWorkspaceTransferRoutes({
  app,
  coreDb,
  dataRoot,
  isActiveWorkspaceMember,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string | null;
  /** Optional server-mode active membership check for same-deployment exports. */
  readonly isActiveWorkspaceMember?: (userId: string, workspaceId: string) => boolean;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'exportWorkspace', (c) => {
    if (!dataRoot) {
      return asApiError('Workspace export is unavailable.', 'workspace_export_unavailable', 503);
    }

    const workspaceId = c.req.param('workspaceId');
    const store = requestStore(c);
    const workspace = store.getWorkspace(workspaceId);
    const threads = store.listThreads(workspaceId);
    const turns = threads.flatMap((thread) => store.listThreadTurns(workspaceId, thread.id));
    const workspaceRoot = join(dataRoot, 'users', store.getUserId(), 'workspaces', workspaceId);
    assertCanonicalDirectory(workspaceRoot);
    const dataSourceCatalogPath = join(workspaceRoot, 'config', 'data-sources.jsonc');
    const dataSourceCatalog = existsSync(dataSourceCatalogPath)
      ? parseWorkspaceDataSourceCatalog(
          parseJsoncObject(readFileSync(dataSourceCatalogPath, 'utf8'), dataSourceCatalogPath)
        )
      : null;
    const workspaceRowFamilies = collectWorkspaceExportRows(
      coreDb,
      store,
      workspaceId,
      repositoryWorkspaceDb
    );
    const workspaceVaultGrants = coreDb
      ? listExportableWorkspaceVaultGrants(coreDb, workspaceId)
      : [];
    const workspaceInjectionPlans = coreDb
      ? listExportableInjectionPlans(
          coreDb,
          workspaceVaultGrants.map((grant) => grant.grantId)
        )
      : [];
    const exportId = `wsexp_${randomUUID()}`;
    assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
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
    const exported = writeWorkspaceExportTree({
      exportRoot,
      exportId,
      sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      createdAt: new Date().toISOString(),
      workspace,
      threads,
      turns,
      knowledge: store.listKnowledge(workspaceId),
      knowledgeProposalReviews: store.listKnowledgeProposalReviewDecisions(workspaceId),
      knowledgeProposals: store.listKnowledgeProposals(workspaceId),
      knowledgeSources: store.listKnowledgeSources(workspaceId),
      knowledgeSourceMaterials: store.listKnowledgeSourceMaterials(workspaceId),
      itemRevisions: store.listWorkspaceItemRevisions(workspaceId),
      artifacts: store.listArtifacts(workspaceId),
      artifactReviews: store.listArtifactReviewDecisions(workspaceId),
      agentSessions: store.listWorkspaceAgentSessions(workspaceId),
      turnEvents: turns.map((turn) => [turn.id, store.getTurnEventsForExport(turn.id)]),
      portableFileState: readWorkspacePortableFileState(workspaceRoot),
      ...(dataSourceCatalog ? { dataSourceCatalog } : {}),
      auditEvents: workspaceRowFamilies.auditEvents,
      agentEnvironmentPackageSnapshots: workspaceRowFamilies.agentEnvironmentPackageSnapshots,
      capabilityCalls: workspaceRowFamilies.capabilityCalls,
      evidenceBundles: workspaceRowFamilies.evidenceBundles,
      gitPushRecords: workspaceRowFamilies.gitPushRecords,
      goalRecords: workspaceRowFamilies.goalRecords,
      goalReviewRecords: workspaceRowFamilies.goalReviewRecords,
      goalTasks: workspaceRowFamilies.goalTasks,
      goalVerificationRecords: workspaceRowFamilies.goalVerificationRecords,
      injectionPlans: workspaceInjectionPlans,
      injectionReceipts: coreDb
        ? listExportableInjectionReceipts(
            coreDb,
            workspaceInjectionPlans.map((plan) => plan.planId)
          )
        : [],
      mcpToolSchemaSnapshots: workspaceRowFamilies.mcpToolSchemaSnapshots,
      pendingUserTurns: workspaceRowFamilies.pendingUserTurns,
      permissionDecisions: workspaceRowFamilies.permissionDecisions,
      resolvedAgentSetups: workspaceRowFamilies.resolvedAgentSetups,
      runtimeEvidence: workspaceRowFamilies.runtimeEvidence,
      stagedWorkspaceReviews: workspaceRowFamilies.workspaceSyncRecords.stagedReviews,
      usageRecords: workspaceRowFamilies.usageRecords,
      vaultUseRecords: workspaceRowFamilies.vaultUseRecords,
      workerCheckpoints: workspaceRowFamilies.workerCheckpoints,
      workspaceApplyPlans: workspaceRowFamilies.workspaceApplyPlans,
      workspaceApplyResults: workspaceRowFamilies.workspaceApplyResults,
      workspaceReconciliationRecords: workspaceRowFamilies.workspaceReconciliationRecords,
      workspaceQuarantineRecords: workspaceRowFamilies.workspaceQuarantineRecords,
      workspaceSyncEvidenceBundles: workspaceRowFamilies.workspaceSyncEvidenceBundles,
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
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      const now = new Date();

      try {
        const call = startCapabilityCall({
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

    return c.json(
      WorkspaceExportResponseSchema.parse({
        exportId: exported.manifest.id,
        workspaceId,
        manifest: exported.manifest,
        fileCount,
        totalBytes,
        checkedFiles: exported.checkedFiles,
      })
    );
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
      const report = dryRunWorkspaceImport({
        verified,
        workspaceExists: (workspaceId) =>
          importedWorkspaceExists(coreDb, store, dataRoot, workspaceId),
      });
      assertRequestedExportHandles(report, parsed.data.sourceWorkspaceId, parsed.data.exportId);
      if (!canReadWorkspaceExport(dataRoot, store, report, isActiveWorkspaceMember)) {
        return asApiError('Workspace export is unavailable.', 'workspace_import_forbidden', 403);
      }

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
      const workspaceExists = (workspaceId: string) =>
        importedWorkspaceExists(coreDb, store, dataRoot, workspaceId);
      const verified = verifyWorkspaceExportTree({
        exportRoot: existingWorkspaceExportRoot(
          dataRoot,
          parsed.data.sourceWorkspaceId,
          parsed.data.exportId
        ),
      });
      const report = dryRunWorkspaceImport({ verified, workspaceExists });
      assertRequestedExportHandles(report, parsed.data.sourceWorkspaceId, parsed.data.exportId);
      if (!canReadWorkspaceExport(dataRoot, store, report, isActiveWorkspaceMember)) {
        return asApiError('Workspace export is unavailable.', 'workspace_import_forbidden', 403);
      }
      const importedWorkspaceId =
        report.collision.status === 'available'
          ? report.collision.workspaceId
          : nextImportedWorkspaceId(report.collision.suggestedWorkspaceId, workspaceExists);
      const snapshot = readWorkspaceImportSnapshot({
        verified,
        targetWorkspaceId: importedWorkspaceId,
      });
      const importCoreDb = coreDb;
      const stageWorkspace = ({ workspaceRoot }: ImportWorkspaceStage) => {
        writeWorkspacePortableFileState(workspaceRoot, snapshot.portableFileState);
        if (snapshot.dataSourceCatalog) {
          const catalogRoot = join(workspaceRoot, 'config');
          mkdirSync(catalogRoot, { recursive: true });
          writeFileSync(
            join(catalogRoot, 'data-sources.jsonc'),
            `${JSON.stringify(snapshot.dataSourceCatalog, null, 2)}\n`
          );
        }
        if (!importCoreDb) {
          return;
        }
        importWorkspaceDatabaseRows({
          coreDb: importCoreDb,
          store,
          workspaceRoot,
          importedWorkspaceId,
          requestId: parsed.data.requestId ?? null,
          report,
          snapshot,
        });
      };
      const workspace = publishImportedWorkspace(importCoreDb, store, snapshot, stageWorkspace);

      return c.json(
        WorkspaceImportResponseSchema.parse({
          ...report,
          mode: 'imported',
          requestId: parsed.data.requestId ?? null,
          importedWorkspaceId: workspace.id,
          workspace,
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
