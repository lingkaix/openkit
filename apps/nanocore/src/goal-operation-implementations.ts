import type {
  GOAL_OPERATION_DEFINITIONS,
  OperationDefinition,
  OperationInput,
} from '@openkit/app-api-schemas';
import {
  authorizeWorkspace,
  isCurrentDeploymentAdministrator,
} from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
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
  requireCoordinatorGoal,
} from './runtime/goal-owner.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';

/** Supplies exact Goal identity facts and only the bindings declared by the selected operation. */
export function coordinatorOperationBindings(
  context: Extract<OperationInvocationContext, { kind: 'coordinator' }>,
  definition: OperationDefinition
): {
  readonly identity: Readonly<Record<string, unknown>>;
  readonly bindings: Readonly<Record<string, unknown>>;
} {
  const bindings = {
    workspaceId: context.workspaceId,
    threadId: context.threadId,
    goalId: context.goalId,
    ...(definition.mutating ? { requestId: context.requestId } : {}),
  };
  return {
    identity: { ...bindings, requestId: context.requestId },
    bindings: Object.fromEntries(
      Object.entries(bindings).filter(([field]) =>
        Object.hasOwn(definition.inputSchema.shape, field)
      )
    ),
  };
}

/** Revalidates the live Goal, Thread, credential and mutation fence before collection discovery. */
export function resolveCoordinatorWorkspaceCandidates(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'store' | 'repositoryWorkspaceDb' | 'workspaceMutationAdmission'
  >,
  entry: Extract<OperationInvocationContext, { kind: 'coordinator' }>,
  definition: OperationDefinition
): readonly string[] | null {
  const { coreDb, store, repositoryWorkspaceDb, workspaceMutationAdmission } = dependencies;
  if (
    !coreDb ||
    !store ||
    !repositoryWorkspaceDb ||
    !workspaceMutationAdmission ||
    workspaceMutationAdmission.isClosed(entry.workspaceId) ||
    !authorizeWorkspace(coreDb, entry.actor, entry.workspaceId, definition)
  )
    return null;
  const db = repositoryWorkspaceDb(entry.workspaceId);
  try {
    requireCoordinatorGoal(store, db, entry);
    try {
      if (
        !isThreadIdVisible(
          store,
          entry.workspaceId,
          entry.threadId,
          entry.actor.userId,
          isCurrentDeploymentAdministrator(coreDb, entry.actor),
          definition.policyOperation,
          { kind: 'user', userId: entry.actor.userId }
        )
      )
        throw new OperationError('not_found', 'Thread not found.', 404);
    } catch {
      throw new OperationError('not_found', 'Thread not found.', 404);
    }
  } finally {
    db.sqlite.close();
  }
  // Candidate restriction precedes the Agent owner's content reads, including administrator discovery.
  return [entry.workspaceId];
}

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
