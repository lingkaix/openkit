import type { WORKSPACE_TRANSFER_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { WorkspaceImportDryRunResponseSchema } from '@openkit/app-api-schemas';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import type {
  OperationImplementations,
  OperationInvocationContext,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { dryRunWorkspaceImport, verifyWorkspaceExportTree } from './workspace-export.js';
import {
  assertRequestedExportHandles,
  canReadWorkspaceExport,
  createVerifiedWorkspaceExport,
  existingWorkspaceExportRoot,
  importedWorkspaceExists,
  importVerifiedWorkspace,
} from './workspace-transfer-routes.js';

/** Joins JSON transfer definitions to the existing verified-tree and staged publication owners. */
export function createWorkspaceTransferOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'coreDb' | 'store' | 'repositoryWorkspaceDb'>
) {
  const { coreDb, repositoryWorkspaceDb, store } = dependencies;
  return {
    'workspace.export': (input, context) => {
      // Definition credential admission proves public context before this native join.
      const actor = (context as Extract<OperationInvocationContext, { kind: 'public' }>).actor;
      const dataRoot = store?.getDataRoot();
      if (!dataRoot)
        throw new OperationError(
          'workspace_export_unavailable',
          'Workspace export is unavailable.',
          503
        );
      return createVerifiedWorkspaceExport({
        authorityUserId: actor.userId,
        administratorEligible: Boolean(coreDb && isCurrentDeploymentAdministrator(coreDb, actor)),
        coreDb,
        dataRoot,
        repositoryWorkspaceDb: repositoryWorkspaceDb!,
        store: store!,
        workspaceId: input.workspaceId,
      }).response;
    },
    'workspace.import-dry-run': (input, context) => {
      const actor = (context as Extract<OperationInvocationContext, { kind: 'public' }>).actor;
      const dataRoot = store?.getDataRoot();
      if (!dataRoot)
        throw new OperationError(
          'workspace_import_unavailable',
          'Workspace import dry-run is unavailable.',
          503
        );
      try {
        const verified = verifyWorkspaceExportTree({
          exportRoot: existingWorkspaceExportRoot(
            dataRoot,
            input.sourceWorkspaceId,
            input.exportId
          ),
        });
        if (!canReadWorkspaceExport(dataRoot, store!, actor, verified, coreDb))
          throw new OperationError(
            'workspace_import_forbidden',
            'Workspace export is unavailable.',
            403
          );
        const report = dryRunWorkspaceImport({
          verified,
          workspaceExists: (workspaceId) =>
            importedWorkspaceExists(coreDb, store!, dataRoot, workspaceId),
        });
        assertRequestedExportHandles(report, input.sourceWorkspaceId, input.exportId);
        return WorkspaceImportDryRunResponseSchema.parse(report);
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw new OperationError(
          'workspace_import_dry_run_failed',
          'Workspace import dry-run could not verify the requested export.',
          400
        );
      }
    },
    'workspace.import': (input, context) => {
      const actor = (context as Extract<OperationInvocationContext, { kind: 'public' }>).actor;
      const dataRoot = store?.getDataRoot();
      if (!dataRoot)
        throw new OperationError(
          'workspace_import_unavailable',
          'Workspace import is unavailable.',
          503
        );
      try {
        const verified = verifyWorkspaceExportTree({
          exportRoot: existingWorkspaceExportRoot(
            dataRoot,
            input.sourceWorkspaceId,
            input.exportId
          ),
        });
        if (!canReadWorkspaceExport(dataRoot, store!, actor, verified, coreDb))
          throw new OperationError(
            'workspace_import_forbidden',
            'Workspace export is unavailable.',
            403
          );
        const report = dryRunWorkspaceImport({
          verified,
          workspaceExists: (workspaceId) =>
            importedWorkspaceExists(coreDb, store!, dataRoot, workspaceId),
        });
        assertRequestedExportHandles(report, input.sourceWorkspaceId, input.exportId);
        return importVerifiedWorkspace({
          authorityUserId: actor.userId,
          coreDb,
          dataRoot,
          requestId: input.requestId ?? null,
          store: store!,
          verified,
        });
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw new OperationError(
          'workspace_import_failed',
          'Workspace import could not verify or publish the requested export.',
          400
        );
      }
    },
  } satisfies Pick<OperationImplementations, keyof typeof WORKSPACE_TRANSFER_OPERATION_DEFINITIONS>;
}
