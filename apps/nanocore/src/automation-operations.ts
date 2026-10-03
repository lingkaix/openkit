import type { AUTOMATION_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { publishedErrorMessage } from './api-errors.js';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import type {
  OperationImplementations,
  OperationInvocationDependencies,
} from './operation-invocation.js';

/** Published automation owner failure, preserved across projections. */
export class AutomationOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 404
  ) {
    super(message);
  }
}
/** Joins automation definitions to the existing process-local record owner. */
export function createAutomationOperationImplementations(
  dependencies: OperationInvocationDependencies
): Pick<OperationImplementations, keyof typeof AUTOMATION_OPERATION_DEFINITIONS> {
  const store = dependencies.automationStore!;
  return {
    'automation.list': (_input, actor, context, workspaceIds) => {
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
    'automation.create': (input, actor) => {
      requireWorkspaceRecords([input.workspaceId]);
      return store.createAutomation(actor.id, input);
    },
    'automation.update': (input, actor, context) => {
      try {
        return store.updateAutomation(
          owner(input.automationId, actor.id, context),
          input.automationId,
          input
        );
      } catch (error) {
        throw new AutomationOperationError(
          'automation_update_failed',
          publishedErrorMessage(error)
        );
      }
    },
    'automation.delete': (input, actor, context) => {
      try {
        store.deleteAutomation(owner(input.automationId, actor.id, context), input.automationId);
        return null;
      } catch (error) {
        throw new AutomationOperationError(
          'automation_delete_failed',
          publishedErrorMessage(error)
        );
      }
    },
  };
  /** Collection and creation retain the former uncaught Workspace-record failure. */
  function requireWorkspaceRecords(workspaceIds: readonly string[]): void {
    try {
      for (const workspaceId of workspaceIds) dependencies.store!.getWorkspace(workspaceId);
    } catch {
      throw new AutomationOperationError('internal_error', 'Internal Server Error', 500);
    }
  }
  /** Reuses the same minimum record selector after invocation has admitted its Workspace. */
  function owner(
    id: string,
    userId: string,
    context: Parameters<OperationImplementations['automation.delete']>[2]
  ): string {
    const lineage = store.getAutomationLineage(
      id,
      userId,
      context.kind === 'public' &&
        dependencies.coreDb !== undefined &&
        isCurrentDeploymentAdministrator(dependencies.coreDb, context.actor)
    );
    if (!lineage) throw new Error(`Automation not found: ${id}`);
    dependencies.store!.getWorkspace(lineage.workspaceId);
    return lineage.ownerUserId;
  }
}
