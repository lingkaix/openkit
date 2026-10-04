import type { GOAL_OPERATION_DEFINITIONS, OperationInput } from '@openkit/app-api-schemas';
import type { OperationInvocationDependencies } from './operation-composition.js';
import {
  type FamilyImplementations,
  type OperationInvocationContext,
  publicOperationActor,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  executeGoalOperation,
  GoalCommandError,
  type GoalOperationId,
} from './runtime/goal-owner.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
/** Exact ten-key join to the sole Goal domain owner. */
export function createGoalOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'repositoryWorkspaceDb' | 'store' | 'goalServices' | 'coreDb' | 'inflightCommands'
  >
) {
  const execute = async <K extends GoalOperationId>(
    id: K,
    input: OperationInput<K>,
    context: OperationInvocationContext
  ): Promise<import('@openkit/app-api-schemas').GoalView> => {
    const db = dependencies.repositoryWorkspaceDb!(input.workspaceId);
    try {
      return await executeGoalOperation(
        id,
        input,
        {
          actor: publicOperationActor(context),
          ...(context.kind === 'coordinator' ? { coordinatorTurnId: context.turnId } : {}),
        },
        dependencies.store!,
        db,
        {
          ...dependencies.goalServices,
          ...(dependencies.coreDb ? { coreDb: dependencies.coreDb } : {}),
          inflightCommands: dependencies.inflightCommands!,
        }
      );
    } catch (error) {
      if (error instanceof GoalCommandError || error instanceof IdempotencyKeyConflictError)
        throw new OperationError(error.code, error.message, error.status, { cause: error });
      throw error;
    } finally {
      db.sqlite.close();
    }
  };
  return {
    'goal.create': (input, context) => execute('goal.create', input, context),
    'goal.intent.revise': (input, context) => execute('goal.intent.revise', input, context),
    'goal.card.create': (input, context) => execute('goal.card.create', input, context),
    'goal.card.edit': (input, context) => execute('goal.card.edit', input, context),
    'goal.card.cancel': (input, context) => execute('goal.card.cancel', input, context),
    'goal.plan.propose': (input, context) => execute('goal.plan.propose', input, context),
    'goal.plan.approve': (input, context) => execute('goal.plan.approve', input, context),
    'goal.cancel': (input, context) => execute('goal.cancel', input, context),
    'goal.completion.accept': (input, context) => execute('goal.completion.accept', input, context),
    'goal.read': (input, context) => execute('goal.read', input, context),
  } satisfies FamilyImplementations<typeof GOAL_OPERATION_DEFINITIONS>;
}
