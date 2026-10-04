import type { KERNEL_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { createRecord, getLightApp } from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { kernelOperationFailure } from './generative-operations.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { FamilyImplementations } from './operation-contract.js';
/** Joins only executable behavior to the definition's exact operation keys. */
export function createKernelOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'store' | 'inflightCommands'>
) {
  return {
    'kernel.apps.get': async (input) => {
      try {
        return await getLightApp(kernelDataRoot(dependencies), input.workspaceId, input.appId);
      } catch (error) {
        kernelOperationFailure(error);
      }
    },
    'kernel.records.create': async (input, context) => {
      try {
        const actor = context.actorRef;
        return await createRecord(
          {
            store: dependencies.store!,
            inflightCommands: dependencies.inflightCommands!,
            dataRoot: kernelDataRoot(dependencies),
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            actor,
          },
          input.appId,
          input.collection,
          input.schemaRevision,
          input.data
        );
      } catch (error) {
        kernelOperationFailure(error);
      }
    },
  } satisfies FamilyImplementations<typeof KERNEL_OPERATION_DEFINITIONS>;
}

/** Requires the existing Kernel storage owner without creating substitute state. */
function kernelDataRoot(
  dependencies: Pick<OperationInvocationDependencies, 'store' | 'inflightCommands'>
): string {
  const dataRoot = dependencies.store?.getDataRoot();
  if (!dataRoot) throw new KernelCommandError('unavailable', 'Workspace storage is unavailable.');
  return dataRoot;
}
