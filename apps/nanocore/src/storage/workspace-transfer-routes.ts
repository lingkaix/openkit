import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import type { CoreDb, WorkspaceDb } from './db.js';
import { openWorkspaceDbAtRoot } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import {
  dryRunWorkspaceImport,
  readWorkspaceImportSnapshot,
  writeWorkspaceExportTree,
} from './workspace-export.js';

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
    const dataSourceCatalogPath = join(
      dataRoot,
      'users',
      store.getUserId(),
      'workspaces',
      workspaceId,
      'config',
      'data-sources.jsonc'
    );
    const dataSourceCatalog = existsSync(dataSourceCatalogPath)
      ? parseWorkspaceDataSourceCatalog(
          parseJsoncObject(readFileSync(dataSourceCatalogPath, 'utf8'), dataSourceCatalogPath)
        )
      : null;
    const workspaceRowFamilies = coreDb
      ? (() => {
          const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

          try {
            const workspaceSyncRecords = listExportableWorkspaceSyncRecords(
              workspaceDb,
              workspaceId
            );

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
              goalVerificationRecords: listExportableGoalVerificationRecords(
                workspaceDb,
                workspaceId
              ),
              mcpToolSchemaSnapshots: listExportableMcpToolSchemaSnapshots(
                workspaceDb,
                workspaceId
              ),
              pendingUserTurns: listExportablePendingUserTurns(workspaceDb, workspaceId),
              permissionDecisions: listExportableWorkspacePermissionDecisions(
                workspaceDb,
                workspaceId
              ),
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
              workspaceRepositories: listExportableWorkspaceRepositoryResources(
                workspaceDb,
                workspaceId
              ),
              workspaceSyncRecords,
            };
          } finally {
            workspaceDb.sqlite.close();
          }
        })()
      : {
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
    const exported = writeWorkspaceExportTree({
      exportRoot: join(dataRoot, 'server', 'exports', 'workspaces', workspaceId, exportId),
      exportId,
      sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      createdAt: new Date().toISOString(),
      workspace,
      threads,
      knowledge: store.listKnowledge(workspaceId),
      knowledgeProposalReviews: store.listKnowledgeProposalReviewDecisions(workspaceId),
      knowledgeProposals: store.listKnowledgeProposals(workspaceId),
      knowledgeSources: store.listKnowledgeSources(workspaceId),
      knowledgeSourceMaterials: store.listKnowledgeSourceMaterials(workspaceId),
      threadItems: threads.flatMap((thread) => store.listThreadItems(workspaceId, thread.id)),
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
      const report = dryRunWorkspaceImport({
        exportRoot: join(
          dataRoot,
          'server',
          'exports',
          'workspaces',
          parsed.data.sourceWorkspaceId,
          parsed.data.exportId
        ),
        workspaceExists: (workspaceId) => {
          try {
            requestStore(c).getWorkspace(workspaceId);
            return true;
          } catch {
            return false;
          }
        },
      });

      return c.json(WorkspaceImportDryRunResponseSchema.parse(report));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return asApiError(message, 'workspace_import_dry_run_failed', 400);
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
    const workspaceExists = (workspaceId: string) => {
      try {
        store.getWorkspace(workspaceId);
        return true;
      } catch {
        return false;
      }
    };
    const exportRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      parsed.data.sourceWorkspaceId,
      parsed.data.exportId
    );

    try {
      const report = dryRunWorkspaceImport({ exportRoot, workspaceExists });
      const importedWorkspaceId =
        report.collision.status === 'available'
          ? report.collision.workspaceId
          : nextImportedWorkspaceId(report.collision.suggestedWorkspaceId, workspaceExists);
      const snapshot = readWorkspaceImportSnapshot({
        exportRoot,
        targetWorkspaceId: importedWorkspaceId,
      });
      const importCoreDb = coreDb;
      const stageWorkspace = importCoreDb
        ? ({ workspaceRoot }: ImportWorkspaceStage) => {
            if (snapshot.dataSourceCatalog) {
              const catalogRoot = join(workspaceRoot, 'config');
              mkdirSync(catalogRoot, { recursive: true });
              writeFileSync(
                join(catalogRoot, 'data-sources.jsonc'),
                `${JSON.stringify(snapshot.dataSourceCatalog, null, 2)}\n`
              );
            }

            const workspaceDb = openWorkspaceDbAtRoot({
              dataRoot: importCoreDb.dataRoot,
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
              importWorkspaceReconciliationRecords(
                workspaceDb,
                snapshot.workspaceReconciliationRecords
              );
              importWorkspaceQuarantineRecords(workspaceDb, snapshot.workspaceQuarantineRecords);
              importWorkspaceSyncEvidenceBundles(
                workspaceDb,
                snapshot.workspaceSyncEvidenceBundles
              );
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
              importAgentEnvironmentPackageSnapshots(
                workspaceDb,
                snapshot.agentEnvironmentPackageSnapshots
              );
              recordWorkspaceAuditEvent({
                workspaceDb,
                workspaceId: importedWorkspaceId,
                requestId: parsed.data.requestId ?? null,
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
                requestId: parsed.data.requestId ?? null,
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
        : undefined;
      const workspace = store.importWorkspaceSnapshot({
        ...snapshot,
        ...(stageWorkspace ? { stageWorkspace } : {}),
      });

      if (importCoreDb) {
        for (const reference of snapshot.vaultReferences) {
          importUnboundWorkspaceVaultReference(importCoreDb, reference);
        }
        importWorkspaceVaultGrants(importCoreDb, snapshot.vaultGrants);
        importInjectionPlans(importCoreDb, snapshot.injectionPlans);
        importInjectionReceipts(importCoreDb, snapshot.injectionReceipts);
      }

      return c.json(
        WorkspaceImportResponseSchema.parse({
          ...report,
          mode: 'imported',
          requestId: parsed.data.requestId ?? null,
          importedWorkspaceId: workspace.id,
          workspace,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return asApiError(message, 'workspace_import_failed', 400);
    }
  });
}
