import type { CORE_COMMAND_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { ProductTurnSchema } from '@openkit/protocol';
import { publishedErrorMessage } from './api-errors.js';
import { readWorkspaceDashboard } from './app-dashboard.js';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import { CoreCommandError, throwCoreCommandError } from './core-command-errors.js';
import { quickChatWorkspaceIdForUser } from './lib/store.js';
import type {
  OperationImplementations,
  OperationInvocationContext,
  OperationInvocationDependencies,
} from './operation-invocation.js';
import { updateTurnFeedback } from './runtime/feedback.js';
import { archiveThread, updateThread } from './thread-routes.js';
import { interruptProductTurn, startTurn } from './turn-routes.js';
import { createWorkspace, readWorkspace, updateWorkspace } from './workspace-operations.js';

/** Requires the authenticated public actor already admitted by native invocation. */
function publicActor(context: OperationInvocationContext) {
  if (context.kind === 'worker')
    throw new CoreCommandError('workspace_access_denied', 'Workspace access denied.', 403);
  return context.actor;
}

/** Joins the remaining commands to their native owners and preserves former fallback envelopes. */
export function createCoreCommandOperationImplementations(
  dependencies: OperationInvocationDependencies
): Pick<OperationImplementations, keyof typeof CORE_COMMAND_OPERATION_DEFINITIONS> {
  const store = dependencies.store!;
  const workspaceDependencies = {
    store,
    coreDb: dependencies.coreDb,
    inflightCommands: dependencies.inflightCommands!,
  };
  const administrator = (context: OperationInvocationContext) =>
    isCurrentDeploymentAdministrator(dependencies.coreDb!, publicActor(context));
  return {
    'workspace.create': (input, _actor, context) =>
      createWorkspace(input, workspaceDependencies, publicActor(context), administrator(context)),
    'workspace.read': (input, _actor, context) =>
      readWorkspace(
        store,
        dependencies.coreDb,
        input.workspaceId,
        publicActor(context).userId,
        administrator(context)
      ),
    'workspace.update': (input, _actor, context) =>
      updateWorkspace(input, workspaceDependencies, publicActor(context), administrator(context)),
    'workspace.dashboard': (input, _actor, context) =>
      readWorkspaceDashboard({
        ...input,
        ...workspaceDependencies,
        actor: publicActor(context),
        runtimeConfigManager: dependencies.runtimeConfigManager!,
        administratorEligible: administrator(context),
      }),
    'thread.list': (input, _actor, context) => {
      try {
        return {
          items: store
            .listThreads(input.workspaceId)
            .filter((thread) =>
              isThreadVisible(store, thread, publicActor(context).userId, administrator(context))
            ),
        };
      } catch (error) {
        throw new CoreCommandError('not_found', publishedErrorMessage(error), 404);
      }
    },
    'thread.update': (input) => updateThread(input, workspaceDependencies),
    'thread.archive': (input, _actor, context) =>
      archiveThread(
        input,
        {
          ...workspaceDependencies,
          ...(dependencies.coreDb
            ? { repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb! }
            : {}),
        },
        publicActor(context)
      ),
    'turn.start': (input, _actor, context) =>
      startTurn(input, store, publicActor(context), dependencies.turnStartServices!),
    'turn.interrupt': async (input) => {
      try {
        store.getTurn(input.workspaceId, input.threadId, input.turnId);
        return ProductTurnSchema.parse(
          await interruptProductTurn({
            ...input,
            ...workspaceDependencies,
            turnExecutor: dependencies.turnExecutor!,
            interruptInternalChatTurn: dependencies.conversationService!.interrupt,
          })
        );
      } catch (error) {
        throwCoreCommandError(error, 'turn_interrupt_failed');
      }
    },
    'turn.feedback': (input) => {
      const { turnId, ...body } = input;
      try {
        return updateTurnFeedback(store, turnId, body);
      } catch (error) {
        throw new CoreCommandError('not_found', publishedErrorMessage(error), 404);
      }
    },
    'chat.quick': (input, _actor, context) =>
      dependencies.conversationService!.quick(
        input,
        publicActor(context),
        quickChatWorkspaceIdForUser(publicActor(context).userId),
        context.kind === 'public' && context.signal ? context.signal : new AbortController().signal
      ),
  };
}
