import type { APP_SEARCH_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { listOutputArtifacts } from './artifact-catalog.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
/** Searches only the admitted Workspace candidates and visible Thread-derived content. */
export function createAppSearchOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'coreDb' | 'store'>
) {
  return {
    'app.search': async (input, context) => {
      const query = input.query.trim().toLowerCase();

      if (!query) {
        return { items: [] };
      }

      const store = dependencies.store!;
      const actor = publicOperationActor(context);
      const userId = actor.userId;
      const administratorEligible = Boolean(
        dependencies.coreDb && isCurrentDeploymentAdministrator(dependencies.coreDb, actor)
      );
      if (context.scope.kind !== 'authorized-workspace-set')
        throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
      const workspaces = context.scope.workspaceIds.map((workspaceId) =>
        store.getWorkspace(workspaceId)
      );
      const matches = (value: string | null | undefined) => value?.toLowerCase().includes(query);
      const items: Array<{
        kind: 'workspace' | 'thread' | 'knowledge' | 'artifact' | 'item';
        id: string;
        title: string;
        workspaceId?: string;
        threadId?: string;
      }> = [];

      for (const workspace of workspaces) {
        if (matches(workspace.name)) {
          items.push({ kind: 'workspace', id: workspace.id, title: workspace.name });
        }

        const knowledgeReadable = dependencies.coreDb
          ? isWorkspaceOperationAuthorized(dependencies.coreDb, actor, workspace.id, {
              mutating: false,
              policyOperation: 'knowledge.read',
            })
          : actor.kind === 'local';
        if (knowledgeReadable) {
          const dataRoot = store.getDataRoot();
          if (!dataRoot)
            throw new OperationError(
              'data_root_required',
              'Knowledge retrieval requires durable storage.',
              409
            );
          const access = {
            store,
            coreDb: dependencies.coreDb,
            actor: context.actorRef,
            requestActor: actor,
          };
          const trace = await retrieveWorkspaceKnowledge({
            dataRoot,
            workspaceId: workspace.id,
            access,
            caller: 'app-api',
            query: input.query,
            limit: 20,
          });
          const pages = resolveWorkspaceKnowledgeRetrievalPages({
            dataRoot,
            workspaceId: workspace.id,
            access,
            caller: 'app-api',
            retrievalTraceId: trace.traceId,
          });
          if (!pages)
            throw new OperationError(
              'knowledge_retrieval_failed',
              'Knowledge source is unavailable.',
              503
            );
          for (const page of pages)
            items.push({
              kind: 'knowledge',
              id: page.knowledgePageId,
              title: page.title,
              workspaceId: workspace.id,
            });
        }

        for (const artifact of listOutputArtifacts(
          store,
          dependencies.coreDb,
          workspace.id,
          userId,
          administratorEligible
        )) {
          if (matches(artifact.title) || matches(artifact.summary)) {
            const result = {
              kind: 'artifact',
              id: artifact.id,
              title: artifact.title,
              workspaceId: workspace.id,
              ...(artifact.threadId ? { threadId: artifact.threadId } : {}),
            } as const;
            items.push(result);
          }
        }
      }

      for (const workspace of workspaces) {
        for (const thread of store.listThreads(workspace.id)) {
          if (!isThreadVisible(store, thread, userId, administratorEligible)) continue;
          if (matches(thread.name) || matches(thread.preview)) {
            items.push({
              kind: 'thread',
              id: thread.id,
              title: thread.name ?? thread.id,
              workspaceId: thread.workspaceId,
            });
          }

          for (const item of store.listThreadItems(workspace.id, thread.id)) {
            if ('text' in item && matches(item.text)) {
              items.push({
                kind: 'item',
                id: item.id,
                title: item.text ?? item.id,
                workspaceId: item.workspaceId,
                threadId: item.threadId,
              });
            }
          }
        }
      }

      return { items };
    },
  } satisfies FamilyImplementations<typeof APP_SEARCH_OPERATION_DEFINITIONS>;
}
