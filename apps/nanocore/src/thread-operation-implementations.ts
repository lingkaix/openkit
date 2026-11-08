import type { THREAD_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { responsibleUserIdForActor } from '@openkit/protocol';
import { HTTPException } from 'hono/http-exception';
import { readThreadDashboard } from './app-dashboard.js';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { PendingRequestCommandError } from './runtime/pending-request-error.js';
import { markThreadRead, readThreadReadState } from './thread-read-state.js';
import { archiveThread, createThread, updateThread } from './thread-routes.js';
import { readThreadItemBody, readThreadTimeline } from './thread-timeline.js';
/** Joins Thread creation, record/history reads and dashboard projection without a second lifecycle. */
export function createThreadOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'store' | 'inflightCommands' | 'coreDb' | 'runtimeConfigManager' | 'repositoryWorkspaceDb'
  >
) {
  const commandDependencies = {
    store: dependencies.store!,
    inflightCommands: dependencies.inflightCommands!,
  };
  return {
    'thread.list': (input, context) => {
      try {
        return {
          items: dependencies
            .store!.listThreads(input.workspaceId)
            .filter((thread) =>
              isThreadVisible(
                dependencies.store!,
                thread,
                publicOperationActor(context).userId,
                isCurrentDeploymentAdministrator(
                  dependencies.coreDb!,
                  publicOperationActor(context)
                )
              )
            ),
        };
      } catch (error) {
        threadCommandFailure(error, 'not_found');
      }
    },
    'thread.update': async (input, context) => {
      try {
        return await updateThread(input, commandDependencies, context);
      } catch (error) {
        threadCommandFailure(error, 'thread_update_failed');
      }
    },
    'thread.archive': async (input, context) => {
      try {
        return await archiveThread(
          input,
          {
            ...commandDependencies,
            ...(dependencies.coreDb
              ? { repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb! }
              : {}),
          },
          publicOperationActor(context)
        );
      } catch (error) {
        threadCommandFailure(error, 'thread_archive_failed');
      }
    },
    'thread.create': async (input, context) => {
      try {
        const actor = context.actorRef;
        return await createThread(
          input,
          { store: dependencies.store!, inflightCommands: dependencies.inflightCommands! },
          responsibleUserIdForActor(actor)!,
          context
        );
      } catch (error) {
        if (error instanceof HTTPException && error.status === 404)
          throw new OperationError('not_found', 'Thread not found.', 404, { cause: error });
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('not_found', error.message, 404, { cause: error });
        if (error instanceof IdempotencyKeyConflictError)
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
    'thread.read': async (input) => {
      try {
        return await dependencies.store!.getThread(input.workspaceId, input.threadId);
      } catch (error) {
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('not_found', error.message, 404, { cause: error });
        if (error instanceof IdempotencyKeyConflictError)
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
    // Page only the admitted public read; internal callers retain complete chronological history.
    'thread.timeline': (input, context) => {
      try {
        return readThreadTimeline({
          input,
          store: dependencies.store!,
          coreDb: dependencies.coreDb,
          repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb,
          actor: publicOperationActor(context),
          administratorEligible: isCurrentDeploymentAdministrator(
            dependencies.coreDb!,
            publicOperationActor(context)
          ),
        });
      } catch (error) {
        threadCommandFailure(error, 'not_found');
      }
    },
    'thread.item-body': (input, context) => {
      try {
        const actor = publicOperationActor(context);
        return readThreadItemBody(
          {
            input,
            actor,
            store: dependencies.store!,
            coreDb: dependencies.coreDb,
            repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb,
            administratorEligible: isCurrentDeploymentAdministrator(dependencies.coreDb!, actor),
          },
          input.turnId,
          input.itemId
        );
      } catch (error) {
        threadCommandFailure(error, 'not_found');
      }
    },
    'thread.items': async (input) => {
      try {
        const items = dependencies.store!.listThreadItems(input.workspaceId, input.threadId);
        const offset = Number(input.cursor ?? '0');
        const page = items.slice(
          offset,
          input.limit === undefined ? undefined : offset + input.limit
        );
        const nextOffset = offset + page.length;
        return await {
          items: page,
          nextCursor: nextOffset < items.length ? String(nextOffset) : null,
        };
      } catch (error) {
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('not_found', error.message, 404, { cause: error });
        if (error instanceof IdempotencyKeyConflictError)
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
    'thread.read-state': (input, context) => {
      try {
        return readThreadReadState({
          ...input,
          store: dependencies.store!,
          coreDb: dependencies.coreDb!,
          userId: publicOperationActor(context).userId,
        });
      } catch (error) {
        threadCommandFailure(error, 'thread_read_state_failed');
      }
    },
    'thread.mark-read': async (input, context) => {
      try {
        return await markThreadRead({
          ...input,
          recheckAdmission: context.recheckAdmission,
          store: dependencies.store!,
          coreDb: dependencies.coreDb!,
          userId: publicOperationActor(context).userId,
        });
      } catch (error) {
        threadCommandFailure(error, 'thread_mark_read_failed');
      }
    },
    'thread.dashboard': async (input, context) => {
      try {
        return await readThreadDashboard({
          ...input,
          store: dependencies.store!,
          coreDb: dependencies.coreDb,
          actor: publicOperationActor(context),
          runtimeConfigManager: dependencies.runtimeConfigManager!,
          repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb!,
          administratorEligible: isCurrentDeploymentAdministrator(
            dependencies.coreDb!,
            publicOperationActor(context)
          ),
        });
      } catch (error) {
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('not_found', error.message, 404, { cause: error });
        if (error instanceof IdempotencyKeyConflictError)
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
  } satisfies FamilyImplementations<typeof THREAD_OPERATION_DEFINITIONS>;
}

/** Keeps known native Thread command refusals inside this family; arbitrary exceptions escape. */
function threadCommandFailure(error: unknown, missingCode: string): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof KernelCommandError) {
    const details = {
      ...(error.limit === undefined ? {} : { limit: error.limit }),
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
    };
    throw new OperationError(error.code, error.message, error.status, {
      cause: error,
      ...(Object.keys(details).length ? { details } : {}),
      ...(error.path === undefined ? {} : { path: [error.path] }),
    });
  }
  if (
    error instanceof KnowledgePageValidationError ||
    error instanceof IdempotencyKeyConflictError ||
    error instanceof PendingRequestCommandError
  )
    throw new OperationError(error.code, error.message, error.status, { cause: error });
  if (error instanceof StoreRecordNotFoundError)
    throw new OperationError(missingCode, error.message, 404, { cause: error });
  throw error;
}
