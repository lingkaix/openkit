import type { LOCAL_AI_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { FamilyImplementations } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { activeLocalAiSupervisor } from './supervisor.js';

/** Admin operations for the built-in local backends. */
export function createLocalAiOperationImplementations(): FamilyImplementations<
  typeof LOCAL_AI_OPERATION_DEFINITIONS
> {
  return {
    'local-ai.status': async () => supervisor().status(),
    'local-ai.enable': async (input) => {
      try {
        return await supervisor().enable({
          backendId: input.backendId,
          acceptLicense: true,
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          ...(input.threads === undefined ? {} : { threads: input.threads }),
        });
      } catch (error) {
        throw operationFailure(error);
      }
    },
    'local-ai.disable': async (input) => {
      try {
        return await supervisor().disable({
          backendId: input.backendId,
          ...(input.deleteModels === undefined ? {} : { deleteModels: input.deleteModels }),
        });
      } catch (error) {
        throw operationFailure(error);
      }
    },
  };
}

function supervisor() {
  const current = activeLocalAiSupervisor();
  if (!current) throw new OperationError('local_ai_unavailable', 'Local AI is unavailable.', 503);
  return current;
}

function operationFailure(error: unknown): OperationError {
  if (error instanceof OperationError) return error;
  return new OperationError('local_ai_failed', 'Local AI request failed.', 502, { cause: error });
}
