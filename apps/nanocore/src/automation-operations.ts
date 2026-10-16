import type {
  AUTOMATION_OPERATION_DEFINITIONS,
  AutomationHistoryResponse,
} from '@openkit/app-api-schemas';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import { AutomationMutationError, AutomationRecordNotFoundError } from './lib/automation-store.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { OperationImplementations } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { requireSchedulerAdmissionEntry } from './scheduler-records.js';
/** Joins fixed-interval operations to the durable Workspace schedule owner. */
export function createAutomationOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'automationStore' | 'coreDb' | 'store'>
) {
  const store = dependencies.automationStore!;
  return {
    'automation.list': (_input, context) => {
      const workspaceIds =
        context.scope.kind === 'authorized-workspace-set' ? context.scope.workspaceIds : [];
      requireWorkspaceRecords(workspaceIds);
      return {
        items: store.listAuthorizedAutomations(workspaceIds),
      };
    },
    'automation.history': (input, context) => {
      requireAdmittedSchedule(input.automationId, context);
      const history = store.listHistory(input.automationId, input.limit, input.before);
      const items: AutomationHistoryResponse['items'] = history.items.map((entry) => {
        if (entry.kind === 'expired-range') return entry;
        const { resolvedPayload, ...record } = entry.record;
        return {
          kind: 'occurrence',
          record: {
            ...record,
            resolvedSelection: resolvedPayload
              ? {
                  agentId: resolvedPayload.requestedAgentId,
                  profileId: resolvedPayload.profileRef,
                  modelId: resolvedPayload.modelId,
                }
              : null,
            schedulerStatus: record.queueEntryId
              ? requireSchedulerAdmissionEntry(dependencies.coreDb!, record.queueEntryId).status
              : null,
          },
        };
      });
      return { items, nextBefore: history.nextBefore };
    },
    'automation.create': (input, context) => {
      const actor = context.actorRef;
      requireWorkspaceRecords([input.workspaceId]);
      requireThread(input.workspaceId, input.threadId, actor.id, context);
      return store.createAutomation(actor.id, input);
    },
    'automation.update': (input, context) => {
      const actor = context.actorRef;
      try {
        requireAdmittedSchedule(input.automationId, context);
        if (input.threadId)
          requireThread(
            store.getAutomation(input.automationId).workspaceId,
            input.threadId,
            actor.id,
            context
          );
        const { automationId, ...mutation } = input;
        return store.updateAutomation(actor.id, automationId, mutation);
      } catch (error) {
        if (error instanceof AutomationMutationError)
          throw new OperationError('automation_conflict', error.message, 409, { cause: error });
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
        requireAdmittedSchedule(input.automationId, context);
        store.deleteAutomation(actor.id, input.automationId);
        return null;
      } catch (error) {
        if (error instanceof AutomationMutationError)
          throw new OperationError('automation_conflict', error.message, 409, { cause: error });
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
  /** A schedule targets an existing Thread in its admitted Workspace. */
  function requireThread(
    workspaceId: string,
    threadId: string,
    userId: string,
    context: Parameters<OperationImplementations['automation.delete']>[1]
  ): void {
    try {
      dependencies.store!.getThread(workspaceId, threadId);
      if (
        !isThreadIdVisible(
          dependencies.store!,
          workspaceId,
          threadId,
          userId,
          context.kind === 'public' &&
            dependencies.coreDb !== undefined &&
            isCurrentDeploymentAdministrator(dependencies.coreDb, context.actor)
        )
      )
        throw new OperationError(
          'automation_target_not_found',
          'Schedule target Thread not found.',
          404
        );
    } catch (error) {
      if (!(error instanceof StoreRecordNotFoundError)) throw error;
      throw new OperationError(
        'automation_target_not_found',
        'Schedule target Thread not found.',
        404,
        { cause: error }
      );
    }
  }
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
  function requireAdmittedSchedule(
    id: string,
    context: Parameters<OperationImplementations['automation.delete']>[1]
  ): void {
    const lineage = store.getAutomationLineage(id);
    const admitted = context.resolvedLineage;
    if (!admitted) throw new Error('Automation execution requires admitted lineage.');
    if (
      !lineage ||
      lineage.workspaceId !== admitted.workspaceId ||
      lineage.ownerUserId !== admitted.ownerUserId
    )
      throw new AutomationRecordNotFoundError(`Automation not found: ${id}`);
    dependencies.store!.getWorkspace(lineage.workspaceId);
  }
}

/** Reads only Automation ownership for the closed resolver before protected content admission. */
export function readAutomationOperationLineage(
  store: import('./lib/automation-store.js').AutomationStore | undefined,
  id: string
) {
  return store?.getAutomationLineage(id) ?? null;
}
