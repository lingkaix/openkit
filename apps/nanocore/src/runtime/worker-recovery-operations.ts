import type { RECOVERY_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  ListInterruptedWorkerStatesResponseSchema,
  type RetryInterruptedWorkerCheckpointResponse,
  RetryInterruptedWorkerCheckpointResponseSchema,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { publishedErrorMessage } from '../api-errors.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import type {
  OperationImplementations,
  OperationInvocationDependencies,
} from '../operation-invocation.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { commandInputHash, IdempotencyKeyConflictError } from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import { updateWorkerCheckpoint } from './worker-checkpoints.js';
import {
  clearWorkerCheckpointAfterTerminalState,
  materializeInterruptedWorkerStates,
  resolveInterruptedWorkerRetryDecision,
} from './worker-recovery.js';

/** Recovery projection failure preserves the command owner's published status and code. */
export class RecoveryOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}
/** Joins recovery listing and release to the unchanged checkpoint, receipt and cleanup owners. */
export function createRecoveryOperationImplementations(
  dependencies: OperationInvocationDependencies
): Pick<OperationImplementations, keyof typeof RECOVERY_OPERATION_DEFINITIONS> {
  const { repositoryWorkspaceDb } = dependencies;
  // Native invocation admits Core storage before entering this family.
  const coreDb = dependencies.coreDb!;
  const store = dependencies.store!;
  return {
    'recovery.worker-list': (_input, actor, context, workspaceIds) => {
      try {
        return ListInterruptedWorkerStatesResponseSchema.parse({
          items: workspaceIds.flatMap((workspaceId) => {
            const workspaceDb = repositoryWorkspaceDb!(workspaceId);
            try {
              return materializeInterruptedWorkerStates(coreDb, store, workspaceDb, (checkpoint) =>
                isThreadIdVisible(
                  store,
                  checkpoint.workspaceId,
                  checkpoint.threadId,
                  actor.id,
                  context.kind === 'public' &&
                    isCurrentDeploymentAdministrator(coreDb, context.actor)
                )
              );
            } finally {
              workspaceDb.sqlite.close();
            }
          }),
        });
      } catch (error) {
        throw new RecoveryOperationError('recovery_list_failed', publishedErrorMessage(error));
      }
    },
    'recovery.checkpoint-retry': async (input) => {
      try {
        const turn = store.getTurnById(input.turnId);
        store.getWorkspace(input.workspaceId);
        store.getThread(input.workspaceId, input.threadId);
        const workspaceDb = repositoryWorkspaceDb!(input.workspaceId);
        try {
          const response = runInterruptedWorkerRetryCommand({
            ...input,
            authorityActor: turn.triggerActor,
            coreDb,
            store,
            workspaceDb,
          });
          await clearWorkerCheckpointAfterTerminalState(workspaceDb, input);
          return response;
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        if (
          error instanceof RecoveryOperationError ||
          error instanceof TurnStartValidationError ||
          error instanceof IdempotencyKeyConflictError
        )
          throw error;
        throw new RecoveryOperationError('recovery_retry_failed', publishedErrorMessage(error));
      }
    },
  };
}

/**
 * Atomically releases one authoritatively interrupted attempt for a later fresh start.
 *
 * @param input Existing authority stores, exact lineage, and caller request identity.
 * @returns Stable release result for fresh execution and exact replay.
 * @throws IdempotencyKeyConflictError when the request identity conflicts.
 * @throws TurnStartValidationError when reconnect or recovery authority forbids retry.
 */
function runInterruptedWorkerRetryCommand(input: {
  readonly authorityActor: ActorRef;
  readonly coreDb: CoreDb;
  readonly requestId: string;
  readonly store: FsStore;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): RetryInterruptedWorkerCheckpointResponse {
  const command = 'worker.recovery.retry' as const;
  const scope = {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
  };
  const inputHash = commandInputHash({});

  return input.workspaceDb.sqlite.transaction(() => {
    const receipt = input.store.getCommandRequest(
      command,
      input.requestId,
      scope,
      input.workspaceDb
    );
    if (receipt) {
      if (receipt.inputHash !== inputHash) {
        throw new IdempotencyKeyConflictError();
      }
      if (
        receipt.command !== command ||
        receipt.requestId !== input.requestId ||
        receipt.scope.workspaceId !== input.workspaceId ||
        receipt.scope.threadId !== input.threadId ||
        receipt.scope.turnId !== input.turnId ||
        Object.keys(receipt.scope).length !== 3 ||
        receipt.response.kind !== 'turn' ||
        receipt.response.id !== input.turnId
      ) {
        throw retryRecoveryRequired('Interrupted-worker retry receipt has invalid lineage.');
      }
      assertInterruptedTurn(input.store, input.workspaceId, input.threadId, input.turnId);
      return RetryInterruptedWorkerCheckpointResponseSchema.parse({
        outcome: 'released_for_retry',
        turnId: input.turnId,
      });
    }

    const decision = resolveInterruptedWorkerRetryDecision(
      input.coreDb,
      input.store,
      input.workspaceDb,
      {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId,
      }
    );
    if (decision.status === 'reconnect-pending') {
      throw new TurnStartValidationError(
        'worker_reconnect_pending',
        'The original worker still owns an active reconnect window.',
        409
      );
    }
    if (decision.status === 'stale') {
      throw new TurnStartValidationError(
        'worker_recovery_stale',
        'The original worker attempt is no longer eligible for retry.',
        409
      );
    }
    if (decision.status !== 'eligible' || !decision.checkpoint) {
      throw retryRecoveryRequired(
        'Interrupted-worker cleanup or continuation authority is incomplete.'
      );
    }

    updateWorkerCheckpoint(input.workspaceDb, {
      authorityActor: input.authorityActor,
      diagnosticsSummary: 'Interrupted worker attempt released for a later fresh start.',
      stage: 'aborted',
      stopReason: 'aborted',
      threadId: input.threadId,
      turnId: input.turnId,
      workspaceId: input.workspaceId,
    });

    input.store.recordCommandRequest(
      {
        command,
        inputHash,
        requestId: input.requestId,
        response: { id: input.turnId, kind: 'turn' },
        scope,
      },
      input.workspaceDb
    );
    return RetryInterruptedWorkerCheckpointResponseSchema.parse({
      outcome: 'released_for_retry',
      turnId: input.turnId,
    });
  })();
}

/** Confirms that the command receipt still names the original interrupted Turn. */
function assertInterruptedTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  turnId: string
): void {
  try {
    if (store.getTurn(workspaceId, threadId, turnId).status !== 'interrupted') {
      throw retryRecoveryRequired('Interrupted-worker retry Turn is no longer interrupted.');
    }
  } catch (error) {
    if (error instanceof TurnStartValidationError) {
      throw error;
    }
    throw retryRecoveryRequired('Interrupted-worker retry Turn is unavailable.');
  }
}

/** Creates the stable fail-closed error for incomplete retry authority. */
function retryRecoveryRequired(message: string): TurnStartValidationError {
  return new TurnStartValidationError('recovery_required', message, 409);
}
