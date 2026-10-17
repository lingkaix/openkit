import type { SERVER_THREAD_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { requireCurrentDeploymentAdmin } from './auth/operation-authorizer.js';
import { interruptKnowledgeManagerTurn } from './internal-agents/knowledge-manager-agent.js';
import {
  runServerKnowledgeMaintenanceCommand,
  serverNotebookAdmission,
} from './knowledge/server-knowledge-maintenance.js';
import {
  decideServerNotebookProposal,
  readServerNotebookProposal,
} from './knowledge/server-notebook-proposals.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';

/** Server admission stays with the common invoker; this family rechecks current authority at effects and disclosure. */
export function createServerThreadOperations(
  dependencies: OperationInvocationDependencies
): FamilyImplementations<typeof SERVER_THREAD_OPERATION_DEFINITIONS> {
  const available = () => {
    if (!dependencies.serverKnowledgeMaintenance)
      throw new OperationError(
        'knowledge_unavailable',
        'Server Knowledge Manager is unavailable.',
        503
      );
    return dependencies.serverKnowledgeMaintenance;
  };
  return {
    'knowledge.server.maintain': async (input, context) => {
      const native = available();
      const actor = publicOperationActor(context);
      requireCurrentDeploymentAdmin(native.coreDb, actor);
      return runServerKnowledgeMaintenanceCommand(native, {
        requestId: input.requestId,
        requestActor: actor,
        actor: context.actorRef,
        trigger: 'request',
        instructions: input.instruction,
        sources: input.sourceIds?.map((id) => `source:${id}`) ?? [],
        ...(input.pageIds ? { pageIds: input.pageIds } : {}),
        signal: context.signal ?? new AbortController().signal,
      });
    },
    'knowledge.server.tell': async (input, context) => {
      const native = available();
      const actor = publicOperationActor(context);
      requireCurrentDeploymentAdmin(native.coreDb, actor);
      return runServerKnowledgeMaintenanceCommand(native, {
        requestId: input.requestId,
        requestActor: actor,
        actor: context.actorRef,
        trigger: 'request',
        instructions:
          'Integrate this explicit request and keep the Server notebook overview current.',
        sources: input.sources,
        tellContent: input.content,
        signal: context.signal ?? new AbortController().signal,
      });
    },
    'thread.server.list': (_input, context) => {
      const { coreDb, store } = dependencies;
      if (!coreDb)
        throw new OperationError(
          'operation_storage_unavailable',
          'Server history is unavailable.',
          503
        );
      requireCurrentDeploymentAdmin(coreDb, publicOperationActor(context));
      return { items: store.listServerThreads() };
    },
    'thread.server.read': (input, context) => {
      const { coreDb, store } = dependencies;
      if (!coreDb)
        throw new OperationError(
          'operation_storage_unavailable',
          'Server history is unavailable.',
          503
        );
      requireCurrentDeploymentAdmin(coreDb, publicOperationActor(context));
      return {
        thread: store.getServerThread(input.threadId),
        turns: store.listServerThreadTurns(input.threadId),
      };
    },
    'turn.server.interrupt': async (input, context) => {
      const { coreDb, store } = dependencies;
      if (!coreDb)
        throw new OperationError(
          'operation_storage_unavailable',
          'Server history is unavailable.',
          503
        );
      requireCurrentDeploymentAdmin(coreDb, publicOperationActor(context));
      store.getServerTurnById(input.turnId);
      return {
        turnId: input.turnId,
        interrupted: await interruptKnowledgeManagerTurn(store, input.turnId),
      };
    },
    'knowledge.server.proposal.read': (input, context) => {
      const native = available();
      const actor = publicOperationActor(context);
      requireCurrentDeploymentAdmin(native.coreDb, actor);
      return readServerNotebookProposal(
        { ...native, actor, revalidate: () => serverNotebookAdmission(native, actor) },
        input.proposalId
      );
    },
    'knowledge.server.proposal.decide': async (input, context) => {
      const native = available();
      const actor = publicOperationActor(context);
      requireCurrentDeploymentAdmin(native.coreDb, actor);
      return decideServerNotebookProposal(
        { ...native, actor, revalidate: () => serverNotebookAdmission(native, actor) },
        input
      );
    },
  };
}
