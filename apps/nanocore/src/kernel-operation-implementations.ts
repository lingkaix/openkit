import type { KERNEL_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { responsibleUserIdForActor } from '@openkit/protocol';
import { createRecord, getLightApp } from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { resolveLightAppMeaning } from './generative-kernel/meaning.js';
import { kernelExecutionLineage, kernelOperationFailure } from './generative-operations.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { FamilyImplementations } from './operation-contract.js';
import type { KnowledgeRetrievalAccess } from './retrieval-knowledge-adapter.js';
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
        const access: KnowledgeRetrievalAccess = {
          store: dependencies.store!,
          coreDb: dependencies.coreDb,
          actor: context.actorRef,
          ...(context.kind === 'worker' ? {} : { requestActor: context.actor }),
          outputThreadId: output?.threadId,
          outputTurnId: output?.turnId,
        };
        if (context.kind === 'worker') {
          const userId = responsibleUserIdForActor(context.actorRef);
          const turn = dependencies.store!.getTurnById(context.lineage.turnId);
          if (!userId || !turn.agentId || turn.agentSessionId !== context.lineage.agentSessionId)
            throw new KernelCommandError('access_denied', 'Workspace access denied.');
          // The responsible human's Thread grants never substitute for the executing Agent.
          access.resourcePolicyActor = {
            kind: 'agent',
            userId,
            agentId: turn.agentId,
            processId: context.lineage.agentSessionId,
          };
        }
        const response = {
          ...app,
          meaning: app.schema.references.map((reference) =>
            resolveLightAppMeaning({ workspaceId: input.workspaceId, reference, access })
          ),
        };
        const maximum = 2 * 1024 * 1024;
        if (Buffer.byteLength(JSON.stringify(response), 'utf8') > maximum)
          throw new KernelCommandError('limit_exceeded', 'Read response exceeds 2 MiB.', {
            limit: 'readResponseBytes',
            maximum,
          });
        return response;
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
