import type { AUTOMATION_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import { AutomationRecordNotFoundError } from './lib/automation-store.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { OperationImplementations } from './operation-contract.js';
import { OperationError } from './operation-error.js';
/** Joins automation definitions to the existing process-local record owner. */
export function createAutomationOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'automationStore' | 'coreDb' | 'store'>
) {
  const store = dependencies.automationStore!;
  return {
    'automation.list': (_input, context) => {
      const actor = context.actorRef;
      const workspaceIds =
        context.scope.kind === 'authorized-workspace-set' ? context.scope.workspaceIds : [];
      requireWorkspaceRecords(workspaceIds);
      return {
        items: store.listAuthorizedAutomations(
          actor.id,
          workspaceIds,
          context.kind === 'public' &&
            dependencies.coreDb !== undefined &&
            isCurrentDeploymentAdministrator(dependencies.coreDb, context.actor)
        ),
      };
    },
    'automation.create': (input, context) => {
      const actor = context.actorRef;
      requireWorkspaceRecords([input.workspaceId]);
      return store.createAutomation(actor.id, input);
    },
    'automation.update': (input, context) => {
      const actor = context.actorRef;
      try {
        return store.updateAutomation(
          owner(input.automationId, actor.id, context),
          input.automationId,
          input
        );
      } catch (error) {
        if (
          error instanceof AutomationRecordNotFoundError ||
          error instanceof StoreRecordNotFoundError
        )
          throw new OperationError('automation_update_failed', error.message, 404, {
            cause: error,
          });
        throw error;
      }
    },
    'automation.delete': (input, context) => {
      const actor = context.actorRef;
      try {
        store.deleteAutomation(owner(input.automationId, actor.id, context), input.automationId);
        return null;
      } catch (error) {
        if (
          error instanceof AutomationRecordNotFoundError ||
          error instanceof StoreRecordNotFoundError
        )
          throw new OperationError('automation_delete_failed', error.message, 404, {
            cause: error,
          });
        throw error;
      }
    },
  } satisfies Pick<OperationImplementations, keyof typeof AUTOMATION_OPERATION_DEFINITIONS>;
  /** Collection and creation retain the former uncaught Workspace-record failure. */
  function requireWorkspaceRecords(workspaceIds: readonly string[]): void {
    try {
      for (const workspaceId of workspaceIds) dependencies.store!.getWorkspace(workspaceId);
    } catch (error) {
      if (!(error instanceof StoreRecordNotFoundError)) throw error;
      throw new OperationError('internal_error', 'Internal Server Error', 500);
    }
  }
  /** Reuses the same minimum record selector after invocation has admitted its Workspace. */
  function owner(
    id: string,
    userId: string,
    context: Parameters<OperationImplementations['automation.delete']>[1]
  ): string {
    const lineage = store.getAutomationLineage(
      id,
      userId,
      context.kind === 'public' &&
        dependencies.coreDb !== undefined &&
        isCurrentDeploymentAdministrator(dependencies.coreDb, context.actor)
    );
    const admitted = context.resolvedLineage;
    if (!admitted) throw new Error('Automation execution requires admitted lineage.');
    if (
      !lineage ||
      lineage.workspaceId !== admitted.workspaceId ||
      lineage.ownerUserId !== admitted.ownerUserId
    )
      throw new AutomationRecordNotFoundError(`Automation not found: ${id}`);
    dependencies.store!.getWorkspace(lineage.workspaceId);
    return lineage.ownerUserId;
  }
}

/** Reads only Automation ownership for the closed resolver before protected content admission. */
export function readAutomationOperationLineage(
  store: import('./lib/automation-store.js').AutomationStore | undefined,
  id: string,
  userId: string,
  administratorEligible: boolean
) {
  return store?.getAutomationLineage(id, userId, administratorEligible) ?? null;
}
