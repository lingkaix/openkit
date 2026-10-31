import { finishCapabilityCall, startCapabilityCall } from '../capability/usage-ledger.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import {
  type AdmittedOperationContext,
  type OperationImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';

/** Binds the three Knowledge Manager service operations; native admission and publication stay with their owners. */
export function createKnowledgeAgentOperations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'store' | 'repositoryWorkspaceDb' | 'knowledgeAgent'
  >
) {
  const store = dependencies.store!;
  const coreDb = dependencies.coreDb;
  const repositoryWorkspaceDb = dependencies.repositoryWorkspaceDb!;

  /** The asking call retains delivery bytes; the separate role Turn owns inference and usage. */
  const ask = async (
    input: { workspaceId: string; question: string },
    context: AdmittedOperationContext
  ) => {
    if (!dependencies.knowledgeAgent || !coreDb)
      throw new OperationError('knowledge_unavailable', 'Knowledge Manager is unavailable.', 503);
    const db = repositoryWorkspaceDb(input.workspaceId);
    const call = await startCapabilityCall({
      workspaceDb: db,
      workspaceId: input.workspaceId,
      authorityActor: context.actorRef,
      family: 'knowledge',
      operation: 'knowledge.ask',
      capabilityId: 'knowledge.ask',
      requestId: null,
      providerRef: null,
      serviceRef: 'knowledge-manager',
      redactionClass: 'metadata-only',
      summary: 'Knowledge question.',
      threadId: context.queryContext?.threadId ?? null,
      turnId: context.queryContext?.turnId ?? null,
    });
    try {
      const result = await dependencies.knowledgeAgent.ask({
        ...input,
        caller: context.delivery === 'model' ? 'internal-agent' : 'app-api',
        capabilityCallId: call.id,
        signal: context.signal ?? new AbortController().signal,
        access: {
          store,
          coreDb,
          actor: context.actorRef,
          ...(context.kind === 'worker' ? {} : { requestActor: context.actor }),
          outputThreadId: context.queryContext?.threadId,
          outputTurnId: context.queryContext?.turnId,
        },
      });
      await finishCapabilityCall({
        workspaceDb: db,
        callId: call.id,
        status: 'succeeded',
        deliveredKnowledgeAnswer: JSON.stringify(result),
      });
      return result;
    } catch (error) {
      await finishCapabilityCall({
        workspaceDb: db,
        callId: call.id,
        status: 'failed',
        errorCode: 'knowledge_query_failed',
      });
      throw error;
    } finally {
      db.sqlite.close();
    }
  };

  return {
    'knowledge.ask': ask,
    'knowledge.tell': async (input, context) => {
      if (!dependencies.knowledgeAgent)
        throw new OperationError('knowledge_unavailable', 'Knowledge Manager is unavailable.', 503);
      return dependencies.knowledgeAgent.maintain({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        instructions: 'Integrate the supplied information and keep the notebook overview current.',
        sources: input.sources,
        tellContent: input.content,
        ...(context.queryContext?.threadId
          ? { askingThreadId: context.queryContext.threadId }
          : {}),
        ...(context.queryContext?.turnId ? { askingTurnId: context.queryContext.turnId } : {}),
        trigger: 'request',
        actor: context.actorRef,
        requestActor: publicOperationActor(context),
        signal: context.signal ?? new AbortController().signal,
      });
    },
    'knowledge.maintain': async (input, context) => {
      if (!dependencies.knowledgeAgent)
        throw new OperationError('knowledge_unavailable', 'Knowledge Manager is unavailable.', 503);
      return dependencies.knowledgeAgent.maintain({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        instructions: input.instruction,
        ...(input.pageIds ? { pageIds: input.pageIds } : {}),
        sources: input.sourceIds?.map((id) => `source:${id}`) ?? [],
        trigger: 'request',
        actor: context.actorRef,
        requestActor: publicOperationActor(context),
        signal: context.signal ?? new AbortController().signal,
      });
    },
  } satisfies Pick<
    OperationImplementations,
    'knowledge.ask' | 'knowledge.tell' | 'knowledge.maintain'
  >;
}
