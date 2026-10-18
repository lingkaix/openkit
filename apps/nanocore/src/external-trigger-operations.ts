import type {
  AdmitExternalTriggerRequestSchema,
  AdmitExternalTriggerResponseSchema,
} from '@openkit/app-api-schemas';
import type { z } from 'zod';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { AdmittedOperationContext } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { admitExternalTriggerEvent } from './runtime/external-trigger-service.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';

/** Binds the event bridge to the authenticated scheduled Worker, without public actor substitution. */
export function createExternalTriggerOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'automationStore' | 'store' | 'turnStartServices'
  >
) {
  return {
    'automation.event-admit': async (
      input: z.infer<typeof AdmitExternalTriggerRequestSchema>,
      context: AdmittedOperationContext
    ): Promise<z.infer<typeof AdmitExternalTriggerResponseSchema>> => {
      if (context.kind !== 'worker')
        throw new OperationError(
          'workspace_access_denied',
          'Scheduled Worker admission is required.',
          403
        );
      const schedules = dependencies.automationStore;
      const services = dependencies.turnStartServices;
      if (!schedules || !services || !dependencies.store)
        throw new OperationError(
          'scheduler_unavailable',
          'Scheduled event admission is unavailable.',
          503
        );
      const lineage = context.lineage;
      if (
        input.workspaceId !== lineage.workspaceId ||
        input.threadId !== lineage.threadId ||
        input.turnId !== lineage.turnId
      )
        throw new OperationError(
          'workspace_access_denied',
          'Worker source scope does not match.',
          403
        );
      try {
        const result = await admitExternalTriggerEvent({
          schedules,
          store: dependencies.store,
          snapshot: services.runtimeConfig(),
          turnExecutor: services.turnExecutor,
          providerCredentialResolver: services.providerCredentialResolver,
          ...(services.providerCredentialConfigured
            ? { providerCredentialConfigured: services.providerCredentialConfigured }
            : {}),
          ...(services.subscriptionAccounts
            ? { subscriptionAccounts: services.subscriptionAccounts }
            : {}),
          workerPlacement: services.workerPlacement,
          source: { ...lineage, triggerActor: context.actorRef },
          eventKey: input.eventKey,
          input: input.input,
        });
        return {
          ...result.admission,
          threadId: result.entry.threadId,
          turnId: result.entry.turnId,
          duplicate: result.duplicate,
        };
      } catch (error) {
        if (error instanceof TurnStartValidationError)
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
  };
}
