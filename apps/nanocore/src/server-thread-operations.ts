import type { SERVER_THREAD_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from './auth/operation-authorizer.js';
import { interruptKnowledgeManagerTurn } from './internal-agents/knowledge-manager-agent.js';
import { NotebookError } from './knowledge/notebook.js';
import {
  runServerKnowledgeMaintenanceCommand,
  serverNotebookAdmission,
} from './knowledge/server-knowledge-maintenance.js';
import {
  decideServerNotebookProposal,
  readServerNotebookProposalPreview,
} from './knowledge/server-notebook-proposals.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';

/** Maps only definite owner refusals; unexpected implementation faults remain visible. */
async function serverOperation<T>(invoke: () => Promise<T> | T): Promise<T> {
  try {
    return await invoke();
  } catch (error) {
    if (error instanceof DeploymentAdminRequiredError)
      throw new OperationError(
        'deployment_admin_required',
        'Current Server administration authority is required.',
        403
      );
    if (
      error instanceof StoreRecordNotFoundError ||
      (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    )
      throw new OperationError('server_record_not_found', 'Server work is unavailable.', 404);
    if (error instanceof NotebookError)
      throw new OperationError(
        error.code,
        error.message,
        error.code === 'invalid_request' ? 400 : 409
      );
    if (error instanceof IdempotencyKeyConflictError)
      throw new OperationError(error.code, error.message, error.status);
    throw error;
  }
}

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
    'knowledge.server.maintain': (input, context) =>
      serverOperation(async () => {
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
      }),
    'knowledge.server.tell': (input, context) =>
      serverOperation(async () => {
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
      }),
    'thread.server.list': (_input, context) =>
      serverOperation(async () => {
        const { coreDb, store } = dependencies;
        if (!coreDb || !store)
          throw new OperationError(
            'operation_storage_unavailable',
            'Server history is unavailable.',
            503
          );
        requireCurrentDeploymentAdmin(coreDb, publicOperationActor(context));
        return { items: store.listServerThreads() };
      }),
    'thread.server.read': (input, context) =>
      serverOperation(async () => {
        const { coreDb, store } = dependencies;
        if (!coreDb || !store)
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
      }),
    'turn.server.interrupt': (input, context) =>
      serverOperation(async () => {
        const { coreDb, store } = dependencies;
        if (!coreDb || !store)
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
      }),
    'knowledge.server.proposal.read': (input, context) =>
      serverOperation(async () => {
        const native = available();
        const actor = publicOperationActor(context);
        requireCurrentDeploymentAdmin(native.coreDb, actor);
        return readServerNotebookProposalPreview(
          { ...native, actor, revalidate: () => serverNotebookAdmission(native, actor) },
          input
        );
      }),
    'knowledge.server.proposal.decide': (input, context) =>
      serverOperation(async () => {
        const native = available();
        const actor = publicOperationActor(context);
        requireCurrentDeploymentAdmin(native.coreDb, actor);
        if (context.delivery === 'model')
          throw new OperationError(
            'human_review_required',
            'A human must decide this Server candidate.',
            403
          );
        return decideServerNotebookProposal(
          { ...native, actor, revalidate: () => serverNotebookAdmission(native, actor) },
          input
        );
      }),
  };
}
