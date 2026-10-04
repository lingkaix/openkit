import type { TURN_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { ProductTurnSchema } from '@openkit/protocol';
import { KernelCommandError } from './generative-kernel/errors.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import type { FsStore } from './lib/store.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { FamilyImplementations } from './operation-contract.js';
import { publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { updateTurnFeedback } from './runtime/feedback.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { PendingRequestCommandError } from './runtime/pending-requests.js';
import { interruptProductTurn, readTurn, startTurn } from './turn-routes.js';
/** Joins Turn commands, feedback and detail to their existing lifecycle, receipts and evidence owners. */
export function createTurnOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    | 'store'
    | 'coreDb'
    | 'repositoryWorkspaceDb'
    | 'inflightCommands'
    | 'turnStartServices'
    | 'turnExecutor'
    | 'conversationService'
  >
) {
  return {
    'turn.start': async (input, context) => {
      try {
        return await startTurn(
          input,
          dependencies.store!,
          publicOperationActor(context),
          dependencies.turnStartServices!
        );
      } catch (error) {
        // The native Turn admission owner retains its bounded preparation-failure fallback; admission and resolver errors never enter this catch.
        throw (
          classifiedTurnFailure(error, 'turn_start_failed') ??
          new OperationError('turn_start_failed', 'Turn start failed.', 404, { cause: error })
        );
      }
    },
    'turn.interrupt': async (input) => {
      try {
        dependencies.store!.getTurn(input.workspaceId, input.threadId, input.turnId);
        return ProductTurnSchema.parse(
          await interruptProductTurn({
            ...input,
            store: dependencies.store!,
            coreDb: dependencies.coreDb,
            inflightCommands: dependencies.inflightCommands!,
            turnExecutor: dependencies.turnExecutor!,
            interruptInternalChatTurn: dependencies.conversationService!.interrupt,
          })
        );
      } catch (error) {
        throw classifiedTurnFailure(error, 'turn_interrupt_failed') ?? error;
      }
    },
    'turn.feedback': (input) => {
      const { turnId, ...body } = input;
      try {
        return updateTurnFeedback(dependencies.store!, turnId, body);
      } catch (error) {
        throw classifiedTurnFailure(error, 'not_found') ?? error;
      }
    },
    'turn.read': async (input) => {
      try {
        return await readTurn(
          dependencies.store!,
          dependencies.coreDb,
          dependencies.repositoryWorkspaceDb!,
          input
        );
      } catch (error) {
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('not_found', error.message, 404, { cause: error });
        throw error;
      }
    },
  } satisfies FamilyImplementations<typeof TURN_OPERATION_DEFINITIONS>;
}

/** Turn-owned minimum lineage and known missing-record outcome; unknown reader failures escape. */
export function readTurnOperationLineage(
  store: FsStore,
  turnId: string,
  missing: 'not-found' | 'access-denied' | 'interrupt-failed' = 'not-found'
) {
  try {
    const lineage = store.getTurnLineage(turnId);
    if (lineage) return lineage;
  } catch (error) {
    if (!(error instanceof StoreRecordNotFoundError)) throw error;
  }
  switch (missing) {
    case 'access-denied':
      throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
    case 'interrupt-failed':
      throw new OperationError('turn_interrupt_failed', `Turn not found: ${turnId}`, 404);
    case 'not-found':
      throw new OperationError('not_found', `Turn not found: ${turnId}`, 404);
    default:
      throw new Error('Unknown Turn missing policy.');
  }
}

/** Preserves native Turn refusal codes and safe metadata without classifying arbitrary execution failures. */
function classifiedTurnFailure(error: unknown, missingCode: string): OperationError | undefined {
  if (error instanceof OperationError) return error;
  if (error instanceof KernelCommandError) {
    const details = {
      ...(error.limit === undefined ? {} : { limit: error.limit }),
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
    };
    return new OperationError(error.code, error.message, error.status, {
      cause: error,
      ...(Object.keys(details).length ? { details } : {}),
      ...(error.path === undefined ? {} : { path: [error.path] }),
    });
  }
  if (
    error instanceof KnowledgePageValidationError ||
    error instanceof IdempotencyKeyConflictError ||
    error instanceof TurnStartValidationError ||
    error instanceof PendingRequestCommandError
  )
    return new OperationError(error.code, error.message, error.status, { cause: error });
  if (error instanceof StoreRecordNotFoundError)
    return new OperationError(missingCode, error.message, 404, { cause: error });
  return undefined;
}
