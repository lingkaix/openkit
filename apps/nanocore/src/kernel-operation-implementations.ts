import type { KERNEL_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { createRecord, getLightApp } from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { resolveLightAppMeaning } from './generative-kernel/meaning.js';
import { kernelExecutionLineage, kernelOperationFailure } from './generative-operations.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { FamilyImplementations } from './operation-contract.js';
/** Joins only executable behavior to the definition's exact operation keys. */
export function createKernelOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'store' | 'inflightCommands' | 'coreDb'>
) {
  return {
    'kernel.apps.get': async (input, context) => {
      try {
        const app = getLightApp(kernelDataRoot(dependencies), input.workspaceId, input.appId);
        if (!app.schema?.references.length) return app;
        const output =
          context.kind === 'worker'
            ? context.lineage
            : context.kind === 'coordinator'
              ? context
              : context.queryContext;
        const access = {
          store: dependencies.store!,
          coreDb: dependencies.coreDb,
          actor: context.actorRef,
          ...(context.kind === 'worker' ? {} : { requestActor: context.actor }),
          outputThreadId: output?.threadId,
          outputTurnId: output?.turnId,
        };
        return {
          ...app,
          meaning: app.schema.references.map((reference) =>
            resolveLightAppMeaning({ workspaceId: input.workspaceId, reference, access })
          ),
        };
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
            ...kernelExecutionLineage(dependencies.store!, input.workspaceId, context),
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
