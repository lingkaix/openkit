import type { WORKSPACE_TRANSFER_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import type {
  OperationImplementations,
  OperationInvocationContext,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { createVerifiedWorkspaceExport } from './workspace-transfer-routes.js';

/** Joins the JSON workspace export definition to the existing verified-tree export owner. */
export function createWorkspaceTransferOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'store' | 'repositoryWorkspaceDb' | 'fileAdmission'
  >
) {
  const { coreDb, repositoryWorkspaceDb, store, fileAdmission } = dependencies;
  return {
    'workspace.export': async (input, context) => {
      // Definition credential admission proves public context before this native join.
      const actor = (context as Extract<OperationInvocationContext, { kind: 'public' }>).actor;
      const dataRoot = store?.getDataRoot();
      if (!dataRoot || !fileAdmission)
        throw new OperationError(
          'workspace_export_unavailable',
          'Workspace export is unavailable.',
          503
        );
      return (
        await createVerifiedWorkspaceExport({
          fileAdmission,
          authorityActor: context.actorRef,
          authorityUserId: actor.userId,
          coreDb,
          dataRoot,
          repositoryWorkspaceDb: repositoryWorkspaceDb!,
          store: store!,
          workspaceId: input.workspaceId,
        })
      ).response;
    },
  } satisfies Pick<OperationImplementations, keyof typeof WORKSPACE_TRANSFER_OPERATION_DEFINITIONS>;
}
