import type {
  ATTENTION_OPERATION_DEFINITIONS,
  CONVERSATION_OPERATION_DEFINITIONS,
  TASK_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import { HumanAttentionReadError, readHumanAttention } from './action-center.js';
import { ConversationNavigationReadError, readConversationNavigation } from './app-dashboard.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { steerTask } from './runtime/task-steer.js';
/** Joins conversation, Task and attention definitions to their existing owners without transport context. */
export function createTaskConversationOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    | 'store'
    | 'conversationService'
    | 'coreDb'
    | 'runtimeConfigManager'
    | 'repositoryWorkspaceDb'
    | 'taskStart'
    | 'turnExecutor'
    | 'inflightCommands'
  >
) {
  const store = dependencies.store!;
  return {
    'conversation.targets': async (input, context) => {
      try {
        return await dependencies.conversationService!.targets(
          store,
          input,
          publicOperationActor(context),
          (target) => {
            if (
              !dependencies.coreDb ||
              !isWorkspaceOperationAuthorized(
                dependencies.coreDb,
                publicOperationActor(context),
                target.workspaceId,
                { policyOperation: 'turn.run', mutating: false }
              )
            )
              return { availability: 'unavailable', reason: 'steer_not_authorized' };
            return (
              dependencies.turnExecutor?.readSteerAvailability?.(store, target) ?? {
                availability: 'unavailable',
                reason: 'steer_capability_unavailable',
              }
            );
          }
        );
      } catch (error) {
        if (
          error instanceof HumanAttentionReadError ||
          error instanceof ConversationNavigationReadError ||
          error instanceof TurnStartValidationError ||
          error instanceof IdempotencyKeyConflictError
        )
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
    'conversation.navigation': async (input, context) => {
      try {
        return await readConversationNavigation({
          ...input,
          recheckAdmission: context.recheckAdmission,
          store,
          actor: publicOperationActor(context),
          coreDb: dependencies.coreDb,
          runtimeConfigManager: dependencies.runtimeConfigManager!,
          repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb!,
          administratorEligible: isCurrentDeploymentAdministrator(
            dependencies.coreDb!,
            publicOperationActor(context)
          ),
        });
      } catch (error) {
        if (
          error instanceof HumanAttentionReadError ||
          error instanceof ConversationNavigationReadError ||
          error instanceof TurnStartValidationError ||
          error instanceof IdempotencyKeyConflictError
        )
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
    'conversation.submit': async (input, context) => {
      try {
        const result = await dependencies.conversationService!.submit(
          store,
          input,
          publicOperationActor(context),
          context.actorRef
        );
        context.observeSuccessStatus?.(result.status);
        return result.body;
      } catch (error) {
        if (
          error instanceof HumanAttentionReadError ||
          error instanceof ConversationNavigationReadError ||
          error instanceof TurnStartValidationError ||
          error instanceof IdempotencyKeyConflictError
        )
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
    'task.steer': async (input, context) => {
      try {
        return await steerTask(
          {
            store,
            turnExecutor: dependencies.turnExecutor,
            inflightCommands: dependencies.inflightCommands!,
          },
          input,
          context
        );
      } catch (error) {
        if (error instanceof IdempotencyKeyConflictError)
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
    'task.start': async (input, context) => {
      try {
        return await dependencies.taskStart!(store, input, publicOperationActor(context));
      } catch (error) {
        if (
          error instanceof HumanAttentionReadError ||
          error instanceof ConversationNavigationReadError ||
          error instanceof TurnStartValidationError ||
          error instanceof IdempotencyKeyConflictError
        )
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
    'attention.list': async (input, context) => {
      try {
        return await readHumanAttention({
          ...input,
          store,
          actor: publicOperationActor(context),
          coreDb: dependencies.coreDb,
          repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb!,
          administratorEligible: isCurrentDeploymentAdministrator(
            dependencies.coreDb!,
            publicOperationActor(context)
          ),
        });
      } catch (error) {
        if (
          error instanceof HumanAttentionReadError ||
          error instanceof ConversationNavigationReadError ||
          error instanceof TurnStartValidationError ||
          error instanceof IdempotencyKeyConflictError
        )
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        throw error;
      }
    },
  } satisfies FamilyImplementations<
    typeof CONVERSATION_OPERATION_DEFINITIONS &
      typeof TASK_OPERATION_DEFINITIONS &
      typeof ATTENTION_OPERATION_DEFINITIONS
  >;
}
